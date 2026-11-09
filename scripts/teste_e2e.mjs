// Teste ponta a ponta: 1 pedido válido grava no S3; 1 inválido é rejeitado e logado.
// Uso: AWS_PROFILE=sce node scripts/teste_e2e.mjs
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { REGIAO, saidasStack, eventosLog, jsonSeguro, sleep } from './lib.mjs';

const lambda = new LambdaClient({ region: REGIAO });
const s3 = new S3Client({ region: REGIAO });
const { DadosBucket } = await saidasStack();

const invocarA = (p) => lambda.send(new InvokeCommand({ FunctionName: 'sce-produtor', Payload: Buffer.from(JSON.stringify(p)) }));
const t0 = Date.now() - 5000;

const valido = { pedido_id: `e2e-ok-${randomUUID()}`, valor: 42.5, cliente: 'teste' };
const invalido = { pedido_id: `e2e-bad-${randomUUID()}`, valor: 99999999, cliente: 'teste' };
for (const p of [valido, invalido]) {
  const r = await invocarA(p);
  console.log(`A(${p.pedido_id}) -> status ${r.StatusCode}${r.FunctionError ? ' ERRO ' + r.FunctionError : ''}`);
}

async function existe(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: DadosBucket, Key: key })); return true; } catch { return false; }
}

let okGravado = false, badGravado = false, badLog = null;
for (let i = 0; i < 20 && (!okGravado || !badLog); i++) {
  await sleep(3000);
  okGravado = await existe(`dados/${valido.pedido_id}.json`);
  const ev = await eventosLog('/aws/lambda/sce-consumidor', '{ $.evento = "payload_rejeitado" }', t0, Date.now());
  badLog = ev.map((e) => jsonSeguro(e.message)).find((m) => m?.pedido_id === invalido.pedido_id) || null;
}
badGravado = await existe(`dados/${invalido.pedido_id}.json`);

const resultado = { valido_gravado_s3: okGravado, invalido_gravado_s3: badGravado, invalido_log: badLog };
console.log(JSON.stringify(resultado, null, 2));
const passou = okGravado && !badGravado && !!badLog;
console.log(passou ? 'E2E OK' : 'E2E FALHOU');
process.exit(passou ? 0 : 1);
