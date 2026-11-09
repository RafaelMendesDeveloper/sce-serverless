// Lambda B (consumidor): valida o evento com schema estrito e grava no S3 (prefixo dados/).
// Logs estruturados são escritos como uma linha JSON pura em stdout para que os
// metric filters do CloudWatch (padrão JSON) funcionem.
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const BUCKET = process.env.DADOS_BUCKET;

const CAMPOS = ['pedido_id', 'valor', 'cliente', 'emitido_em'];
const VALOR_MIN = 0.01;
const VALOR_MAX = 10000;

const log = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

export function validar(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'evento_nao_objeto';
  const extras = Object.keys(ev).filter((k) => !CAMPOS.includes(k));
  if (extras.length) return `campo_extra:${extras.join(',')}`;
  for (const c of CAMPOS) if (!(c in ev) || ev[c] === null || ev[c] === undefined) return `campo_ausente:${c}`;
  if (typeof ev.pedido_id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(ev.pedido_id)) return 'tipo_invalido:pedido_id';
  if (typeof ev.valor !== 'number' || !Number.isFinite(ev.valor)) return 'tipo_invalido:valor';
  if (ev.valor < VALOR_MIN || ev.valor > VALOR_MAX) return 'fora_da_faixa:valor';
  if (typeof ev.cliente !== 'string' || ev.cliente.length < 1 || ev.cliente.length > 100) return 'tipo_invalido:cliente';
  if (typeof ev.emitido_em !== 'string' || Number.isNaN(Date.parse(ev.emitido_em))) return 'tipo_invalido:emitido_em';
  return null;
}

// Modo de sondagem (usado só no E1): simula um atacante com execução de código em B
// tentando ler um objeto fora do escopo do papel. Registra se o acesso foi permitido.
async function sondar({ bucket, key }) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const corpo = await r.Body.transformToString();
    log({ evento: 'sondagem_acesso', resultado: 'permitido', bucket, key, bytes: corpo.length });
    return { resultado: 'permitido', bytes: corpo.length };
  } catch (e) {
    log({ evento: 'sondagem_acesso', resultado: 'negado', bucket, key, erro: e.name });
    return { resultado: 'negado', erro: e.name };
  }
}

export const handler = async (ev, ctx) => {
  if (ev && typeof ev === 'object' && ev.sce_sondagem) return sondar(ev.sce_sondagem);

  const motivo = validar(ev);
  if (motivo) {
    const pedidoId = typeof ev?.pedido_id === 'string' ? ev.pedido_id.slice(0, 80) : null;
    log({ evento: 'payload_rejeitado', motivo, tipo: motivo.split(':')[0], pedido_id: pedidoId, request_id: ctx?.awsRequestId });
    return { aceito: false, motivo };
  }

  const key = `dados/${ev.pedido_id}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(ev),
    ContentType: 'application/json',
  }));
  log({ evento: 'pedido_gravado', key });
  return { aceito: true, key };
};
