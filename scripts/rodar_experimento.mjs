// Inicia um experimento FIS com tráfego de fundo, registra timestamps, espera terminar,
// aguarda as métricas consolidarem e grava resultados/<exp>-r<rodada>-<ts>.json.
// Uso: AWS_PROFILE=sce node scripts/rodar_experimento.mjs --exp E1 [--rodada 1] [--taxa 1]
//      [--pre 30] [--pos 60] [--espera 180]
import { FisClient, StartExperimentCommand, GetExperimentCommand, StopExperimentCommand } from '@aws-sdk/client-fis';
import { randomUUID } from 'node:crypto';
import { args, REGIAO, saidasStack, salvarJson, sleep, iso } from './lib.mjs';
import { gerarTrafego } from './trafego.mjs';
import { ANALISES, SAIDA_TEMPLATE } from './analise.mjs';

const a = args({ rodada: 1, taxa: 1, pre: 30, pos: 60, espera: 180 });
if (!SAIDA_TEMPLATE[a.exp]) {
  console.error(`--exp deve ser um de: ${Object.keys(SAIDA_TEMPLATE).join(', ')}`);
  process.exit(1);
}
const fis = new FisClient({ region: REGIAO });
const saidas = await saidasStack();
const templateId = saidas[SAIDA_TEMPLATE[a.exp]];
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// Tráfego de fundo: começa antes (janela "pre") e vai até "pos" segundos após o fim do experimento.
const controle = { parar: false };
log(`tráfego de fundo a ${a.taxa} req/s (pre ${a.pre} s)`);
const trafego = gerarTrafego({ taxa: a.taxa, duracao: 3600, controle, silencioso: true });
await sleep(a.pre * 1000);

let expId;
const pararTudo = async () => {
  if (expId) { try { await fis.send(new StopExperimentCommand({ id: expId })); log('experimento parado (Ctrl+C)'); } catch {} }
  controle.parar = true;
};
process.on('SIGINT', async () => { await pararTudo(); process.exit(130); });

const pedido = Date.now();
const r = await fis.send(new StartExperimentCommand({
  experimentTemplateId: templateId, clientToken: randomUUID(),
  tags: { projeto: 'sce-artigo', experimento: a.exp, rodada: String(a.rodada) },
}));
expId = r.experiment.id;
log(`experimento ${expId} iniciado (template ${templateId})`);

let exp, ultimo = '';
do {
  await sleep(5000);
  exp = (await fis.send(new GetExperimentCommand({ id: expId }))).experiment;
  const estado = `${exp.state.status} | ` + Object.entries(exp.actions || {}).map(([k, v]) => `${k}:${v.state?.status}`).join(' ');
  if (estado !== ultimo) { log(estado); ultimo = estado; }
} while (!['completed', 'stopped', 'failed', 'cancelled'].includes(exp.state.status));

log(`fim do experimento; tráfego segue por mais ${a.pos} s`);
await sleep(a.pos * 1000);
controle.parar = true;
const cliente = await trafego;

const bruto = {
  experimento: a.exp,
  rodada: a.rodada,
  template_id: templateId,
  experimento_id: expId,
  estado: exp.state,
  pedido_inicio: iso(pedido),
  inicio: iso(exp.startTime),
  fim: iso(exp.endTime),
  acoes: Object.fromEntries(Object.entries(exp.actions || {}).map(([k, v]) => [k, {
    acao: v.actionId, estado: v.state, inicio: v.startTime && iso(v.startTime), fim: v.endTime && iso(v.endTime), parametros: v.parameters,
  }])),
  condicoes_parada: exp.stopConditions,
  cliente,
};
const nome = `${a.exp}-r${a.rodada}-${iso(pedido).replace(/[:.]/g, '-')}.json`;
salvarJson(nome, bruto);

log(`aguardando ${a.espera} s para métricas/logs consolidarem`);
await sleep(a.espera * 1000);
const analise = await ANALISES[a.exp.split('-')[0]](bruto, saidas);
salvarJson(nome, { ...bruto, analise });
console.log(JSON.stringify(analise, null, 2));
