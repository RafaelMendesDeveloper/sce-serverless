// Análise de cada experimento a partir do registro bruto de rodar_experimento.mjs.
import { SSMClient, DescribeAutomationExecutionsCommand, GetAutomationExecutionCommand } from '@aws-sdk/client-ssm';
import { IAMClient, GetRolePolicyCommand } from '@aws-sdk/client-iam';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { DescribeAlarmHistoryCommand } from '@aws-sdk/client-cloudwatch';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGIAO, DIR_RESULTADOS, cw, eventosLog, jsonSeguro, iso, metricasFuncao, somaMetricaSce, custo } from './lib.mjs';

const ssm = new SSMClient({ region: REGIAO });
const iam = new IAMClient({ region: REGIAO });
const s3 = new S3Client({ region: REGIAO });

/** --exp -> saída do stack com o id do experiment template. */
export const SAIDA_TEMPLATE = {
  E1: 'E1TemplateId',
  E2: 'E2TemplateId',
  'E3-erro-50': 'E3Erro50TemplateId',
  'E3-erro-100': 'E3Erro100TemplateId',
  'E3-atraso': 'E3AtrasoTemplateId',
};

const seg = (a, b) => (a == null || b == null ? null : Number(((new Date(b) - new Date(a)) / 1000).toFixed(1)));

/** Execução da automação SSM disparada pelo experimento FIS.
 *  O FIS inicia pelo ARN do documento (DocumentName = ARN) e com a sessão
 *  assumed-role/<papel>/<id do experimento> — correlação exata via ExecutedBy. */
async function execucaoAutomacao(prefixoDocumento, inicioExp, experimentoId) {
  const r = await ssm.send(new DescribeAutomationExecutionsCommand({
    Filters: [{ Key: 'StartTimeAfter', Values: [iso(new Date(inicioExp).getTime() - 30000)] }],
  }));
  const ex = (r.AutomationExecutionMetadataList || [])
    .filter((x) => x.DocumentName?.split('/').pop().startsWith(prefixoDocumento))
    .filter((x) => !experimentoId || x.ExecutedBy?.endsWith(`/${experimentoId}`))
    .sort((x, y) => x.ExecutionStartTime - y.ExecutionStartTime)[0];
  if (!ex) return null;
  const det = (await ssm.send(new GetAutomationExecutionCommand({ AutomationExecutionId: ex.AutomationExecutionId }))).AutomationExecution;
  const passos = Object.fromEntries((det.StepExecutions || []).map((s) => [s.StepName, {
    status: s.StepStatus, inicio: s.ExecutionStartTime && iso(s.ExecutionStartTime), fim: s.ExecutionEndTime && iso(s.ExecutionEndTime),
    falha: s.FailureMessage,
  }]));
  return { id: det.AutomationExecutionId, status: det.AutomationExecutionStatus, inicio: iso(det.ExecutionStartTime), fim: det.ExecutionEndTime && iso(det.ExecutionEndTime), passos, saidas: det.Outputs || {} };
}

const payloadSaida = (saidas, chave) => {
  const v = saidas?.[chave]?.[0];
  const p = v && jsonSeguro(v);
  return p ?? v ?? null;
};

/** Eventos de dados do CloudTrail (entregues no S3 com atraso de ~5 min). */
export async function cloudTrailDataEvents(bucket, conta, inicio, fim, filtro) {
  const d = new Date(inicio);
  const prefixo = `AWSLogs/${conta}/CloudTrail/${REGIAO}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/`;
  const out = [];
  let token;
  do {
    const l = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefixo, ContinuationToken: token }));
    for (const o of l.Contents || []) {
      if (o.LastModified < new Date(inicio)) continue;
      const corpo = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: o.Key }))).Body.transformToByteArray();
      for (const rec of JSON.parse(gunzipSync(Buffer.from(corpo)).toString()).Records || []) {
        const t = new Date(rec.eventTime);
        if (t >= new Date(inicio) && t <= new Date(fim) && filtro(rec)) out.push(rec);
      }
    }
    token = l.NextContinuationToken;
  } while (token);
  return out.sort((x, y) => new Date(x.eventTime) - new Date(y.eventTime));
}

// ---------------------------------------------------------------- E1
async function analisarE1(bruto, saidas) {
  const POLITICA = 'sce-e1-permissiva';
  const auto = await execucaoAutomacao('sce-e1', bruto.inicio, bruto.experimento_id);
  const tInjecao = auto?.passos?.AnexarPolitica?.fim ?? null;
  const tRollback = auto?.passos?.RemoverPolitica?.fim ?? null;
  const fimBusca = Date.now();

  // Detecção: eventos que o EventBridge entregou no log group de detecções.
  const det = (await eventosLog(saidas.DeteccoesLogGroup, '', new Date(bruto.inicio).getTime() - 60000, fimBusca))
    .map((e) => ({ ingestao: iso(e.ingestionTime), ev: jsonSeguro(e.message) }))
    .filter((x) => x.ev?.detail?.requestParameters?.policyName === POLITICA)
    .map((x) => ({ evento: x.ev.detail.eventName, hora_evento_api: x.ev.detail.eventTime, hora_registro_deteccao: x.ingestao, principal: x.ev.detail.userIdentity?.arn }));
  const detInj = det.find((d) => d.evento === 'PutRolePolicy') || null;
  const detRb = det.find((d) => d.evento === 'DeleteRolePolicy') || null;

  // Rollback: a política não pode mais existir.
  let politicaPresente = true;
  try { await iam.send(new GetRolePolicyCommand({ RoleName: saidas.ConsumidorRole, PolicyName: POLITICA })); }
  catch (e) { if (e.name === 'NoSuchEntityException') politicaPresente = false; else throw e; }

  const antes = payloadSaida(auto?.saidas, 'SondarAntes.Payload');
  const durante = payloadSaida(auto?.saidas, 'SondarDurante.Payload');
  const depois = payloadSaida(auto?.saidas, 'SondarDepois.Payload');

  // Evidência nos logs de B
  const sondagensLog = (await eventosLog('/aws/lambda/sce-consumidor', '{ $.evento = "sondagem_acesso" }', new Date(bruto.inicio).getTime() - 60000, fimBusca))
    .map((e) => ({ hora: iso(e.timestamp), ...jsonSeguro(e.message) }));

  // Evidência no CloudTrail (data events do bucket sensível) — pode chegar com atraso.
  let ct = [];
  try {
    ct = (await cloudTrailDataEvents(saidas.TrilhaBucket, await contaAtual(), new Date(bruto.inicio).getTime() - 60000, fimBusca,
      (r) => r.eventSource === 's3.amazonaws.com' && r.eventName === 'GetObject' && r.requestParameters?.bucketName === saidas.SensivelBucket))
      .map((r) => ({ hora: r.eventTime, principal: r.userIdentity?.arn, erro: r.errorCode || null }));
  } catch (e) { ct = [{ erro_coleta: e.message }]; }

  const mttd = seg(tInjecao, detInj?.hora_registro_deteccao);
  const rollbackOk = !politicaPresente && depois?.resultado === 'negado';
  return {
    automacao: auto && { id: auto.id, status: auto.status, passos: auto.passos },
    instante_injecao: tInjecao,
    instante_rollback: tRollback,
    janela_exposicao_s: seg(tInjecao, tRollback),
    deteccao: { detectado: !!detInj, mttd_s: mttd, deteccao_rollback_s: seg(tRollback, detRb?.hora_registro_deteccao), eventos: det },
    sondagem: { antes, durante, depois },
    acesso_indevido_sucesso: durante?.resultado === 'permitido',
    acesso_visivel_logs_b: sondagensLog.some((s) => s.resultado === 'permitido'),
    acesso_visivel_cloudtrail: ct.some((r) => r.principal?.includes('sce-consumidor-role') && !r.erro),
    cloudtrail_data_events: ct,
    logs_b_sondagem: sondagensLog,
    rollback_ok: rollbackOk,
    politica_presente_apos: politicaPresente,
    deteccao_antes_do_rollback: detInj && tRollback ? new Date(detInj.hora_registro_deteccao) < new Date(tRollback) : null,
    hipotese_confirmada: !!detInj && rollbackOk,
  };
}

// ---------------------------------------------------------------- alarmes
/** Primeira transição para ALARM de cada alarme na janela, e segundos desde `referencia`. */
export async function transicoesAlarme(nomes, inicio, fim, referencia) {
  const out = {};
  for (const AlarmName of nomes) {
    const r = await cw.send(new DescribeAlarmHistoryCommand({
      AlarmName, HistoryItemType: 'StateUpdate', StartDate: new Date(inicio), EndDate: new Date(fim), ScanBy: 'TimestampAscending',
    }));
    const p = (r.AlarmHistoryItems || []).find((h) => jsonSeguro(h.HistoryData)?.newState?.stateValue === 'ALARM');
    out[AlarmName] = p
      ? { disparou: true, instante: iso(p.Timestamp), segundos_desde_injecao: seg(referencia, p.Timestamp) }
      : { disparou: false, instante: null, segundos_desde_injecao: null };
  }
  return out;
}

// ---------------------------------------------------------------- E3
function estadoEstavel() {
  try { return JSON.parse(readFileSync(join(DIR_RESULTADOS, 'estado_estavel.json'), 'utf8')); } catch { return null; }
}

async function analisarE3(bruto) {
  const acao = Object.values(bruto.acoes)[0];
  const inicioFalha = acao?.inicio ?? bruto.inicio;
  const fimFalha = acao?.fim ?? bruto.fim;
  // Janela: todo o tráfego + 3 min para os retries assíncronos (1 e 2 min após cada falha).
  const inicio = bruto.cliente.inicio;
  const fim = new Date(new Date(bruto.cliente.fim).getTime() + 180000);
  const segundos = (fim - new Date(inicio)) / 1000;

  const A = await metricasFuncao('sce-produtor', inicio, fim);
  const B = await metricasFuncao('sce-consumidor', inicio, fim);
  const gravados = await somaMetricaSce('PedidoGravado', inicio, fim);
  const c = custo({ funcoes: [A, B], putsS3: gravados, segundos });
  const base = estadoEstavel();
  const fatorBase = base?.fator_multiplicacao_b_sobre_a ?? 1;
  const fator = A.invocacoes ? B.invocacoes / A.invocacoes : null;
  const custoPedido = A.invocacoes ? c.custo_janela_usd / A.invocacoes : null;
  const custoPedidoBase = base ? base.custo.custo_janela_usd / base.produtor.invocacoes : null;

  const alarmes = await transicoesAlarme(
    ['sce-invocacoes-b-alto', 'sce-amplificacao-b', 'sce-erro-a-alto'], inicio, new Date(), inicioFalha);
  const primeiroAlarmeCusto = ['sce-invocacoes-b-alto', 'sce-amplificacao-b']
    .map((n) => alarmes[n]).filter((x) => x.disparou).sort((x, y) => x.segundos_desde_injecao - y.segundos_desde_injecao)[0] || null;

  return {
    janela: { inicio, fim: iso(fim), inicio_falha: inicioFalha, fim_falha: fimFalha, segundos },
    parametros: acao?.parametros,
    produtor: A,
    consumidor: B,
    gravados_s3: gravados,
    fator_multiplicacao: fator && Number(fator.toFixed(3)),
    fator_estado_estavel: fatorBase,
    fator_vs_estado_estavel: fator && Number((fator / fatorBase).toFixed(3)),
    throttles_a: A.throttles,
    throttles_b: B.throttles,
    concorrencia_pico_b: B.concorrencia_pico,
    eventos_descartados_b: B.async_descartados,
    custo: c,
    custo_por_pedido_usd: custoPedido && Number(custoPedido.toFixed(10)),
    custo_por_pedido_vs_estado_estavel: custoPedido && custoPedidoBase ? Number((custoPedido / custoPedidoBase).toFixed(2)) : null,
    custo_hora_vs_estado_estavel: base ? Number((c.custo_hora_usd / base.custo.custo_hora_usd).toFixed(2)) : null,
    alarmes,
    tempo_ate_alarme_custo_s: primeiroAlarmeCusto?.segundos_desde_injecao ?? null,
    parado_por_condicao: bruto.estado?.status === 'stopped',
    hipotese_confirmada: !!fator && fator > fatorBase * 1.2 && !!primeiroAlarmeCusto && new Date(primeiroAlarmeCusto.instante) <= new Date(fimFalha),
  };
}

// ---------------------------------------------------------------- E2
async function analisarE2(bruto, saidas) {
  const auto = await execucaoAutomacao('sce-e2', bruto.inicio, bruto.experimento_id);
  const passo = auto?.passos?.InjetarPayloadsAdulterados;
  const res = auto?.saidas?.['InjetarPayloadsAdulterados.Resultado']?.[0];
  const resultado = typeof res === 'string' ? jsonSeguro(res) ?? res : res;
  const marca = resultado?.marca ?? (auto?.id || '').replace(/-/g, '').slice(0, 8);
  const porTipo = Number(resultado?.por_tipo ?? 10);
  const tInjecao = passo?.inicio ?? bruto.inicio;

  // Rejeições de B para os payloads desta execução (pedido_id = e2-<tipo>-<i>-<marca>)
  const rej = (await eventosLog('/aws/lambda/sce-consumidor', '{ $.evento = "payload_rejeitado" }',
    new Date(bruto.inicio).getTime() - 60000, Date.now()))
    .map((e) => ({ hora: iso(e.timestamp), ...jsonSeguro(e.message) }))
    .filter((m) => m.pedido_id?.startsWith('e2-') && m.pedido_id.endsWith(`-${marca}`));
  const tipos = ['extra', 'tipo', 'faixa'];
  const porTipoRes = Object.fromEntries(tipos.map((t) => {
    const ids = new Set(rej.filter((m) => m.pedido_id.startsWith(`e2-${t}-`)).map((m) => m.pedido_id));
    const motivos = [...new Set(rej.filter((m) => m.pedido_id.startsWith(`e2-${t}-`)).map((m) => m.motivo))];
    return [t, { enviados: porTipo, rejeitados: ids.size, taxa_rejeicao_pct: Number((100 * ids.size / porTipo).toFixed(1)), motivos }];
  }));

  // Objetos indevidos no S3 (deve ser 0)
  let indevidos = 0, token;
  do {
    const l = await s3.send(new ListObjectsV2Command({ Bucket: saidas.DadosBucket, Prefix: 'dados/e2-', ContinuationToken: token }));
    indevidos += (l.Contents || []).filter((o) => o.Key.endsWith(`-${marca}.json`)).length;
    token = l.NextContinuationToken;
  } while (token);

  const alarmes = await transicoesAlarme(['sce-rejeicao-payload', 'sce-erro-a-alto'], bruto.inicio, new Date(), tInjecao);
  const totalRej = Object.values(porTipoRes).reduce((a, b) => a + b.rejeitados, 0);
  return {
    automacao: auto && { id: auto.id, status: auto.status, passos: auto.passos, resultado },
    marca,
    instante_injecao: tInjecao,
    por_tipo: porTipoRes,
    total_enviados: porTipo * tipos.length,
    total_rejeitados: totalRej,
    taxa_rejeicao_total_pct: Number((100 * totalRej / (porTipo * tipos.length)).toFixed(1)),
    primeira_rejeicao_s: rej.length ? seg(tInjecao, rej.map((r) => r.hora).sort()[0]) : null,
    objetos_indevidos_s3: indevidos,
    alarmes,
    tempo_ate_alarme_rejeicao_s: alarmes['sce-rejeicao-payload'].segundos_desde_injecao,
    hipotese_confirmada: totalRej === porTipo * tipos.length && indevidos === 0 && alarmes['sce-rejeicao-payload'].disparou,
  };
}

let _conta;
async function contaAtual() {
  if (_conta) return _conta;
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  _conta = (await new STSClient({ region: REGIAO }).send(new GetCallerIdentityCommand({}))).Account;
  return _conta;
}

export const ANALISES = { E1: analisarE1, E2: analisarE2, E3: analisarE3 };
