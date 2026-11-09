// Análise de cada experimento a partir do registro bruto de rodar_experimento.mjs.
import { SSMClient, DescribeAutomationExecutionsCommand, GetAutomationExecutionCommand } from '@aws-sdk/client-ssm';
import { IAMClient, GetRolePolicyCommand } from '@aws-sdk/client-iam';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';
import { REGIAO, eventosLog, jsonSeguro, iso } from './lib.mjs';

const ssm = new SSMClient({ region: REGIAO });
const iam = new IAMClient({ region: REGIAO });
const s3 = new S3Client({ region: REGIAO });

/** --exp -> saída do stack com o id do experiment template. */
export const SAIDA_TEMPLATE = {
  E1: 'E1TemplateId',
};

const seg = (a, b) => (a == null || b == null ? null : Number(((new Date(b) - new Date(a)) / 1000).toFixed(1)));

/** Execução da automação SSM disparada pelo experimento (pela janela de tempo). */
async function execucaoAutomacao(prefixoDocumento, inicioExp) {
  const r = await ssm.send(new DescribeAutomationExecutionsCommand({
    Filters: [
      { Key: 'DocumentNamePrefix', Values: [prefixoDocumento] },
      { Key: 'StartTimeAfter', Values: [iso(new Date(inicioExp).getTime() - 30000)] },
    ],
  }));
  const ex = (r.AutomationExecutionMetadataList || []).sort((x, y) => x.ExecutionStartTime - y.ExecutionStartTime)[0];
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
  const auto = await execucaoAutomacao('sce-e1', bruto.inicio);
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

let _conta;
async function contaAtual() {
  if (_conta) return _conta;
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  _conta = (await new STSClient({ region: REGIAO }).send(new GetCallerIdentityCommand({}))).Account;
  return _conta;
}

export const ANALISES = { E1: analisarE1 };
