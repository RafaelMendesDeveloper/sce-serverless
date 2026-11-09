// Gerador de tráfego: invoca A em malha aberta a uma taxa fixa (req/s) por uma duração (s).
// Uso: AWS_PROFILE=sce node scripts/trafego.mjs --taxa 1 --duracao 60 [--invalidos 0.0]
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { randomUUID } from 'node:crypto';
import { args, REGIAO, iso, sleep } from './lib.mjs';

const lambda = new LambdaClient({ region: REGIAO, maxAttempts: 1 });

function pedido(invalido) {
  const p = { pedido_id: randomUUID(), valor: Number((Math.random() * 500 + 1).toFixed(2)), cliente: `cliente-${Math.floor(Math.random() * 1000)}` };
  if (invalido) p.valor = -1; // fora da faixa
  return p;
}

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** Gera tráfego e devolve o resumo do lado do cliente. */
// `controle.parar = true` encerra o tráfego antes da duração (usado durante experimentos).
export async function gerarTrafego({ taxa = 1, duracao = 60, invalidos = 0, funcao = 'sce-produtor', silencioso = false, controle } = {}) {
  const intervalo = 1000 / taxa;
  const total = Math.round(taxa * duracao);
  const inicio = Date.now();
  const lat = [];
  let ok = 0, erroFuncao = 0, erroApi = 0, throttle = 0;
  const pendentes = [];

  let enviados = 0;
  for (let k = 0; k < total && !controle?.parar; k++, enviados++) {
    const alvo = inicio + k * intervalo;
    const espera = alvo - Date.now();
    if (espera > 0) await sleep(espera);
    const t0 = performance.now();
    pendentes.push(lambda.send(new InvokeCommand({
      FunctionName: funcao, InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(pedido(Math.random() < invalidos))),
    })).then((r) => {
      lat.push(performance.now() - t0);
      if (r.FunctionError) erroFuncao++; else ok++;
    }).catch((e) => {
      if (e.name === 'TooManyRequestsException') throttle++; else erroApi++;
    }));
    if (!silencioso && k > 0 && k % Math.max(1, Math.round(taxa * 30)) === 0) {
      console.log(`[trafego] ${k}/${total} enviados (${Math.round((Date.now() - inicio) / 1000)} s)`);
    }
  }
  await Promise.all(pendentes);
  const fim = Date.now();
  return {
    inicio: iso(inicio), fim: iso(fim), taxa_alvo_rps: taxa, duracao_alvo_s: duracao,
    enviados, ok, erro_funcao: erroFuncao, erro_api: erroApi, throttle_a: throttle,
    taxa_real_rps: Number((enviados / ((fim - inicio) / 1000)).toFixed(3)),
    latencia_cliente_media_ms: lat.length ? Number((lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(1)) : null,
    latencia_cliente_p95_ms: lat.length ? Number(pct(lat, 95).toFixed(1)) : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = args({ taxa: 1, duracao: 60, invalidos: 0 });
  console.log(`[trafego] ${a.taxa} req/s por ${a.duracao} s`);
  console.log(JSON.stringify(await gerarTrafego(a), null, 2));
}
