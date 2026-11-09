// Utilitários compartilhados pelos scripts dos experimentos.
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Trava de segurança: só roda na conta pessoal do artigo.
if (process.env.AWS_PROFILE !== 'sce') {
  console.error('Defina AWS_PROFILE=sce (perfis da empresa não podem ser usados).');
  process.exit(1);
}

export const REGIAO = 'us-east-1';
export const STACK = 'sce-serverless';
export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DIR_RESULTADOS = join(RAIZ, 'resultados');

// Preços us-east-1 (Lambda arm64, S3 Standard) — https://aws.amazon.com/lambda/pricing/
export const PRECO = {
  lambdaGbSegArm: 0.0000133334,
  lambdaPorRequest: 0.20 / 1e6,
  s3PutPorRequest: 0.005 / 1000,
  memoriaGb: 128 / 1024,
};

const cfg = { region: REGIAO };
export const cw = new CloudWatchClient(cfg);
export const logs = new CloudWatchLogsClient(cfg);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const iso = (d) => new Date(d).toISOString();

export function args(defaults = {}) {
  const out = { ...defaults };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : 'true';
    out[k] = Number.isNaN(Number(v)) || v === '' ? v : Number(v);
  }
  return out;
}

let _saidas;
export async function saidasStack() {
  if (_saidas) return _saidas;
  const cf = new CloudFormationClient(cfg);
  const r = await cf.send(new DescribeStacksCommand({ StackName: STACK }));
  _saidas = Object.fromEntries((r.Stacks[0].Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
  return _saidas;
}

export function salvarJson(nome, dados) {
  mkdirSync(DIR_RESULTADOS, { recursive: true });
  const caminho = join(DIR_RESULTADOS, nome);
  writeFileSync(caminho, JSON.stringify(dados, null, 2) + '\n');
  console.log(`resultado salvo em ${caminho}`);
  return caminho;
}

// Período do CloudWatch: múltiplo de 60 s que cobre a janela inteira (um ponto agregado).
function periodoJanela(inicio, fim) {
  return Math.max(60, Math.ceil((new Date(fim) - new Date(inicio)) / 60000) * 60);
}

// Alinha a janela em minutos cheios (as métricas do Lambda têm resolução de 1 min).
export function alinhar(inicio, fim) {
  const i = new Date(inicio); i.setUTCSeconds(0, 0);
  const f = new Date(fim); if (f.getUTCSeconds() || f.getUTCMilliseconds()) { f.setUTCSeconds(0, 0); f.setUTCMinutes(f.getUTCMinutes() + 1); }
  return { inicio: i, fim: f };
}

async function metricData(queries, inicio, fim) {
  const r = await cw.send(new GetMetricDataCommand({
    MetricDataQueries: queries, StartTime: new Date(inicio), EndTime: new Date(fim), ScanBy: 'TimestampAscending',
  }));
  return Object.fromEntries(r.MetricDataResults.map((m) => [m.Id, { ts: m.Timestamps, v: m.Values }]));
}

const soma = (xs) => xs.reduce((a, b) => a + b, 0);

/** Métricas agregadas de uma função na janela + série por minuto de invocações. */
export async function metricasFuncao(nome, inicio, fim) {
  const { inicio: i, fim: f } = alinhar(inicio, fim);
  const P = periodoJanela(i, f);
  const dim = [{ Name: 'FunctionName', Value: nome }];
  const q = (Id, MetricName, Stat, Period = P) => ({
    Id, ReturnData: true, MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName, Dimensions: dim }, Period, Stat },
  });
  const d = await metricData([
    q('inv', 'Invocations', 'Sum', 60),
    q('err', 'Errors', 'Sum', 60),
    q('thr', 'Throttles', 'Sum', 60),
    q('dursum', 'Duration', 'Sum', 60),
    q('durmed', 'Duration', 'Average'),
    q('durp95', 'Duration', 'p95'),
    q('conc', 'ConcurrentExecutions', 'Maximum', 60),
    q('asyncrec', 'AsyncEventsReceived', 'Sum', 60),
    q('asyncdrop', 'AsyncEventsDropped', 'Sum', 60),
    q('asyncage', 'AsyncEventAge', 'Maximum', 60),
  ], i, f);
  const um = (k) => (d[k]?.v?.length ? d[k].v[0] : null);
  return {
    funcao: nome,
    invocacoes: soma(d.inv.v),
    erros: soma(d.err.v),
    throttles: soma(d.thr.v),
    duracao_total_ms: soma(d.dursum.v),
    duracao_media_ms: um('durmed'),
    duracao_p95_ms: um('durp95'),
    concorrencia_pico: d.conc.v.length ? Math.max(...d.conc.v) : 0,
    async_recebidos: soma(d.asyncrec.v),
    async_descartados: soma(d.asyncdrop.v),
    async_idade_max_ms: d.asyncage.v.length ? Math.max(...d.asyncage.v) : 0,
    invocacoes_por_minuto: d.inv.ts.map((t, k) => ({ minuto: iso(t), n: d.inv.v[k] })),
  };
}

/** Soma de uma métrica custom (namespace SCE) na janela. */
export async function somaMetricaSce(nome, inicio, fim) {
  const { inicio: i, fim: f } = alinhar(inicio, fim);
  const d = await metricData([{
    Id: 'm', ReturnData: true,
    MetricStat: { Metric: { Namespace: 'SCE', MetricName: nome }, Period: 60, Stat: 'Sum' },
  }], i, f);
  return soma(d.m.v);
}

/** Custo estimado (US$) de Lambda + PUTs no S3 na janela, e projeção por hora. */
export function custo({ funcoes, putsS3 = 0, segundos }) {
  const req = soma(funcoes.map((f) => f.invocacoes));
  const gbSeg = soma(funcoes.map((f) => f.duracao_total_ms)) / 1000 * PRECO.memoriaGb;
  const janela = req * PRECO.lambdaPorRequest + gbSeg * PRECO.lambdaGbSegArm + putsS3 * PRECO.s3PutPorRequest;
  return {
    requests_lambda: req,
    gb_segundos: Number(gbSeg.toFixed(4)),
    puts_s3: putsS3,
    custo_janela_usd: Number(janela.toFixed(8)),
    custo_hora_usd: Number((janela * 3600 / segundos).toFixed(8)),
    obs: 'estimativa sem free tier; preços us-east-1 arm64',
  };
}

/** Todos os eventos de um log group que casam com o padrão na janela. */
export async function eventosLog(logGroupName, filterPattern, inicio, fim) {
  const out = [];
  let nextToken;
  do {
    const r = await logs.send(new FilterLogEventsCommand({
      logGroupName, filterPattern, startTime: new Date(inicio).getTime(), endTime: new Date(fim).getTime(), nextToken,
    }));
    out.push(...(r.events || []));
    nextToken = r.nextToken;
  } while (nextToken);
  return out;
}

export function jsonSeguro(s) { try { return JSON.parse(s); } catch { return null; } }
