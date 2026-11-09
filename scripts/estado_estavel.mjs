// Linha de base (estado estável): tráfego leve e coleta das métricas de A e B.
// Uso: AWS_PROFILE=sce node scripts/estado_estavel.mjs [--taxa 1] [--duracao 600] [--saida estado_estavel.json]
import { args, metricasFuncao, somaMetricaSce, custo, salvarJson, sleep, iso } from './lib.mjs';
import { gerarTrafego } from './trafego.mjs';

const a = args({ taxa: 1, duracao: 600, espera: 240, saida: 'estado_estavel.json' });

console.log(`[estado-estavel] ${a.taxa} req/s por ${a.duracao} s`);
const cliente = await gerarTrafego({ taxa: a.taxa, duracao: a.duracao });
console.log(`[estado-estavel] tráfego encerrado; aguardando ${a.espera} s para as métricas consolidarem no CloudWatch`);
await sleep(a.espera * 1000);

// Janela de coleta: do início do tráfego até 2 min após o fim (para pegar invocações assíncronas de B).
const fimColeta = new Date(new Date(cliente.fim).getTime() + 120000);
const A = await metricasFuncao('sce-produtor', cliente.inicio, fimColeta);
const B = await metricasFuncao('sce-consumidor', cliente.inicio, fimColeta);
const rejeicoes = await somaMetricaSce('PayloadRejeitado', cliente.inicio, fimColeta);
const gravados = await somaMetricaSce('PedidoGravado', cliente.inicio, fimColeta);

const resultado = {
  experimento: 'estado_estavel',
  coletado_em: iso(Date.now()),
  janela: { inicio: cliente.inicio, fim_trafego: cliente.fim, fim_coleta: iso(fimColeta) },
  cliente,
  produtor: A,
  consumidor: B,
  rejeicoes,
  gravados_s3: gravados,
  fator_multiplicacao_b_sobre_a: A.invocacoes ? Number((B.invocacoes / A.invocacoes).toFixed(3)) : null,
  taxa_erro_a_pct: A.invocacoes ? Number((100 * A.erros / A.invocacoes).toFixed(3)) : null,
  taxa_erro_b_pct: B.invocacoes ? Number((100 * B.erros / B.invocacoes).toFixed(3)) : null,
  custo: custo({ funcoes: [A, B], putsS3: gravados, segundos: a.duracao }),
};
console.log(JSON.stringify({ ...resultado, produtor: { ...A, invocacoes_por_minuto: undefined }, consumidor: { ...B, invocacoes_por_minuto: undefined } }, null, 2));
salvarJson(a.saida, resultado);
