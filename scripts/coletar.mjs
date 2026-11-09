// Consolida os resultados: lê resultados/*.json e gera resumo.md, resumo.csv, tabela2.csv e tabela3.csv.
// Uso: AWS_PROFILE=sce node scripts/coletar.mjs [--reanalisar]   (--reanalisar refaz a análise de cada
// execução, útil para o E1 porque os data events do CloudTrail chegam ao S3 com ~5-15 min de atraso)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args, DIR_RESULTADOS, saidasStack } from './lib.mjs';
import { ANALISES } from './analise.mjs';

const a = args({ reanalisar: false });
const arquivos = readdirSync(DIR_RESULTADOS).filter((f) => /^E\d.*\.json$/.test(f)).sort();
const execs = [];
for (const f of arquivos) {
  const caminho = join(DIR_RESULTADOS, f);
  let r = JSON.parse(readFileSync(caminho, 'utf8'));
  if (a.reanalisar === 'true' || a.reanalisar === true) {
    console.log(`reanalisando ${f}`);
    r.analise = await ANALISES[r.experimento.split('-')[0]](r, await saidasStack());
    writeFileSync(caminho, JSON.stringify(r, null, 2) + '\n');
  }
  if (r.analise) execs.push({ arquivo: f, ...r });
}
const base = JSON.parse(readFileSync(join(DIR_RESULTADOS, 'estado_estavel.json'), 'utf8'));

// ---------------------------------------------------------------- estatística
const nums = (xs) => xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
const media = (xs) => { const v = nums(xs); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; };
const dp = (xs) => {
  const v = nums(xs); if (v.length < 2) return null;
  const m = media(v); return Math.sqrt(v.reduce((p, c) => p + (c - m) ** 2, 0) / (v.length - 1));
};
const f1 = (x, d = 1) => (x == null ? '—' : Number(x).toFixed(d).replace('.', ','));
const mdp = (xs, d = 1) => {
  const v = nums(xs); if (!v.length) return '—';
  return v.length >= 3 ? `${f1(media(v), d)} ± ${f1(dp(v), d)}` : v.map((x) => f1(x, d)).join(' / ');
};
const sn = (b) => (b === true ? 'sim' : b === false ? 'não' : '—');
const conta = (xs, pred) => `${xs.filter(pred).length}/${xs.length}`;

const grupo = (prefixo) => execs.filter((e) => e.experimento === prefixo);
const E1 = grupo('E1'), E2 = grupo('E2');
const E3 = Object.fromEntries(['E3-erro-100', 'E3-erro-50', 'E3-atraso'].map((k) => [k, grupo(k)]));

// ---------------------------------------------------------------- tabela 2 (desenho)
const tabela2 = [
  ['E1', 'Confidencialidade', 'Política inline permissiva (s3:* em *) anexada ao papel de B via SSM Automation, com sondagem de leitura a um bucket fora do escopo',
    'Detecção de mudança de IAM (CloudTrail → EventBridge → SNS + log); rollback automático do runbook', 'Detectado (s/n); MTTD; acesso indevido (s/n) e evidência em logs/CloudTrail; rollback ok'],
  ['E2', 'Integridade', 'Eventos adulterados entregues a B como se A estivesse comprometida (campo extra, tipo errado, valor fora da faixa; 10 de cada)',
    'Validação de schema estrito em B; metric filter + alarme de rejeição', 'Taxa de rejeição por tipo; objetos indevidos no S3; alarme (s/n) e tempo até ele'],
  ['E3', 'Disponibilidade (custo)', 'aws:lambda:invocation-error em B (50% e 100%) e aws:lambda:invocation-add-delay (6 s > timeout) sob rajada de 5 req/s',
    'MaximumRetryAttempts explícito; limite de concorrência; alarmes de invocações/min e de amplificação B/A; Budget (2ª linha)', 'Fator de multiplicação B/A; throttles; pico de concorrência; custo da janela e custo/hora; tempo até o alarme'],
];

// ---------------------------------------------------------------- tabela 3 (resultados)
const t3 = [];
if (E1.length) {
  const ac = E1.filter((e) => e.analise.acesso_indevido_sucesso).length;
  t3.push(['E1', conta(E1, (e) => e.analise.hipotese_confirmada), conta(E1, (e) => e.analise.deteccao.detectado),
    `${mdp(E1.map((e) => e.analise.deteccao.mttd_s))} s`,
    `Acesso indevido bem-sucedido em ${ac}/${E1.length}; rollback ok em ${conta(E1, (e) => e.analise.rollback_ok)}; detecção antes do rollback em ${conta(E1, (e) => e.analise.deteccao_antes_do_rollback)}; janela de exposição ${mdp(E1.map((e) => e.analise.janela_exposicao_s))} s`]);
}
if (E2.length) {
  t3.push(['E2', conta(E2, (e) => e.analise.hipotese_confirmada), conta(E2, (e) => e.analise.alarmes['sce-rejeicao-payload'].disparou),
    `${mdp(E2.map((e) => e.analise.tempo_ate_alarme_rejeicao_s))} s (alarme)`,
    `Rejeição ${mdp(E2.map((e) => e.analise.taxa_rejeicao_total_pct))}%; objetos indevidos no S3: ${E2.map((e) => e.analise.objetos_indevidos_s3).join('/')}`]);
}
for (const [k, xs] of Object.entries(E3)) {
  if (!xs.length) continue;
  t3.push([k, conta(xs, (e) => e.analise.hipotese_confirmada), conta(xs, (e) => e.analise.tempo_ate_alarme_custo_s != null),
    `${mdp(xs.map((e) => e.analise.tempo_ate_alarme_custo_s))} s (alarme de custo)`,
    `Fator B/A ${mdp(xs.map((e) => e.analise.fator_multiplicacao), 2)} (pico por minuto ${mdp(xs.map((e) => e.analise.fator_pico_minuto), 2)}) (estado estável ${f1(base.fator_multiplicacao_b_sobre_a, 2)}); custo/pedido ${mdp(xs.map((e) => e.analise.custo_por_pedido_vs_estado_estavel), 2)}× o estável; throttles A/B ${xs.map((e) => `${e.analise.throttles_a}/${e.analise.throttles_b}`).join(', ')}; pico de concorrência ${xs.map((e) => e.analise.concorrencia_pico_b).join('/')}${xs.some((e) => e.analise.parado_por_condicao) ? '; parado pela condição de parada' : ''}`]);
}

// ---------------------------------------------------------------- markdown
const linhaMd = (cols) => `| ${cols.join(' | ')} |`;
const tabMd = (cab, linhas) => [linhaMd(cab), linhaMd(cab.map(() => '---')), ...linhas.map(linhaMd)].join('\n');
const md = [];
md.push('# Resultados — Security Chaos Engineering em ambiente serverless', '');
md.push(`Gerado em ${new Date().toISOString()} a partir de ${execs.length} execuções em \`resultados/\`. Média ± desvio-padrão amostral quando há ≥ 3 rodadas; valores individuais separados por "/" caso contrário.`, '');
md.push('## Tabela 2 — Desenho dos experimentos', '', tabMd(['Id', 'Pilar', 'Falha injetada', 'Controle esperado', 'Métrica'], tabela2), '');
md.push('## Tabela 3 — Resultados', '', tabMd(['Id', 'Hipótese confirmada?', 'Detectado?', 'Tempo de detecção', 'Observação'], t3), '');

md.push('## Estado estável (linha de base)', '');
md.push(tabMd(['Métrica', 'A (produtor)', 'B (consumidor)'], [
  ['Invocações', base.produtor.invocacoes, base.consumidor.invocacoes],
  ['Erros', base.produtor.erros, base.consumidor.erros],
  ['Throttles', base.produtor.throttles, base.consumidor.throttles],
  ['Duração média (ms)', f1(base.produtor.duracao_media_ms), f1(base.consumidor.duracao_media_ms)],
  ['Duração p95 (ms)', f1(base.produtor.duracao_p95_ms), f1(base.consumidor.duracao_p95_ms)],
  ['Pico de concorrência', base.produtor.concorrencia_pico, base.consumidor.concorrencia_pico],
]), '');
md.push(`Janela de ${f1(base.cliente.duracao_alvo_s / 60, 0)} min a ${base.cliente.taxa_alvo_rps} req/s; fator B/A ${f1(base.fator_multiplicacao_b_sobre_a, 2)}; rejeições ${base.rejeicoes}; gravados ${base.gravados_s3}; latência no cliente ${f1(base.cliente.latencia_cliente_media_ms)} ms (p95 ${f1(base.cliente.latencia_cliente_p95_ms)} ms); custo estimado US$ ${base.custo.custo_janela_usd.toFixed(5)} na janela, **US$ ${base.custo.custo_hora_usd.toFixed(4)}/h**.`, '');

if (E1.length) {
  md.push('## E1 — Permissão excessiva (por execução)', '', tabMd(
    ['Rodada', 'Detectado', 'MTTD (s)', 'Detecção do rollback (s)', 'Exposição (s)', 'Acesso antes/durante/depois', 'Visível logs B', 'Visível CloudTrail', 'Rollback ok', 'Estado FIS'],
    E1.map((e) => { const x = e.analise; return [e.rodada, sn(x.deteccao.detectado), f1(x.deteccao.mttd_s), f1(x.deteccao.deteccao_rollback_s), f1(x.janela_exposicao_s),
      `${x.sondagem.antes?.resultado ?? '—'}/${x.sondagem.durante?.resultado ?? '—'}/${x.sondagem.depois?.resultado ?? '—'}`,
      sn(x.acesso_visivel_logs_b), sn(x.acesso_visivel_cloudtrail), sn(x.rollback_ok), e.estado.status]; })), '');
}
if (E2.length) {
  md.push('## E2 — Payload adulterado (por execução)', '', tabMd(
    ['Rodada', 'Rejeição campo extra', 'Rejeição tipo errado', 'Rejeição fora da faixa', 'Objetos indevidos S3', 'Alarme', 'Tempo até alarme (s)', '1ª rejeição (s)'],
    E2.map((e) => { const x = e.analise; return [e.rodada, `${x.por_tipo.extra.rejeitados}/${x.por_tipo.extra.enviados}`, `${x.por_tipo.tipo.rejeitados}/${x.por_tipo.tipo.enviados}`,
      `${x.por_tipo.faixa.rejeitados}/${x.por_tipo.faixa.enviados}`, x.objetos_indevidos_s3, sn(x.alarmes['sce-rejeicao-payload'].disparou), f1(x.tempo_ate_alarme_rejeicao_s), f1(x.primeira_rejeicao_s)]; })), '');
}
const e3 = Object.values(E3).flat();
if (e3.length) {
  md.push('## E3 — Denial of Wallet (por execução)', '', tabMd(
    ['Variante', 'Rodada', 'Inv. A', 'Inv. B', 'Fator B/A', 'Fator pico/min', 'Throttles A/B', 'Pico conc. B', 'Descartados B', 'Custo janela (US$)', 'Custo/h (US$)', 'Custo/pedido vs estável', 'Alarme invoc. (s)', 'Alarme amplif. (s)', 'Estado FIS'],
    e3.map((e) => { const x = e.analise; return [e.experimento, e.rodada, x.produtor.invocacoes, x.consumidor.invocacoes, f1(x.fator_multiplicacao, 2), f1(x.fator_pico_minuto, 2), `${x.throttles_a}/${x.throttles_b}`,
      x.concorrencia_pico_b, x.eventos_descartados_b, x.custo.custo_janela_usd.toFixed(5), x.custo.custo_hora_usd.toFixed(4), `${f1(x.custo_por_pedido_vs_estado_estavel, 2)}×`,
      f1(x.alarmes['sce-invocacoes-b-alto'].segundos_desde_injecao), f1(x.alarmes['sce-amplificacao-b'].segundos_desde_injecao), e.estado.status]; })), '');
  md.push('Obs.: o AWS Budgets não é atualizado em tempo real; ele foi mantido como controle de segunda linha e não foi usado como métrica.', '');
}
writeFileSync(join(DIR_RESULTADOS, 'resumo.md'), md.join('\n') + '\n');

// ---------------------------------------------------------------- CSV
const csvCel = (v) => { const s = v == null ? '' : String(v); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (cab, linhas) => [cab, ...linhas].map((l) => l.map(csvCel).join(',')).join('\n') + '\n';
writeFileSync(join(DIR_RESULTADOS, 'tabela2.csv'), csv(['Id', 'Pilar', 'Falha injetada', 'Controle esperado', 'Metrica'], tabela2));
writeFileSync(join(DIR_RESULTADOS, 'tabela3.csv'), csv(['Id', 'Hipotese confirmada', 'Detectado', 'Tempo de deteccao', 'Observacao'], t3));
writeFileSync(join(DIR_RESULTADOS, 'resumo.csv'), csv(
  ['experimento', 'rodada', 'arquivo', 'estado_fis', 'hipotese_confirmada', 'detectado', 'tempo_deteccao_s', 'mttd_s', 'acesso_indevido', 'rollback_ok',
    'taxa_rejeicao_pct', 'objetos_indevidos_s3', 'fator_b_sobre_a', 'throttles_a', 'throttles_b', 'pico_concorrencia_b', 'custo_janela_usd', 'custo_hora_usd', 'custo_pedido_vs_estavel'],
  execs.map((e) => {
    const x = e.analise; const id = e.experimento.split('-')[0];
    return [e.experimento, e.rodada, e.arquivo, e.estado.status, x.hipotese_confirmada,
      id === 'E1' ? x.deteccao.detectado : id === 'E2' ? x.alarmes['sce-rejeicao-payload'].disparou : x.tempo_ate_alarme_custo_s != null,
      id === 'E1' ? x.deteccao.mttd_s : id === 'E2' ? x.tempo_ate_alarme_rejeicao_s : x.tempo_ate_alarme_custo_s,
      x.deteccao?.mttd_s, x.acesso_indevido_sucesso, x.rollback_ok, x.taxa_rejeicao_total_pct, x.objetos_indevidos_s3,
      x.fator_multiplicacao, x.throttles_a, x.throttles_b, x.concorrencia_pico_b, x.custo?.custo_janela_usd, x.custo?.custo_hora_usd, x.custo_por_pedido_vs_estado_estavel];
  })));
console.log(`gerados resumo.md, resumo.csv, tabela2.csv, tabela3.csv (${execs.length} execuções)`);
