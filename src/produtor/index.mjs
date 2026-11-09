// Lambda A (produtor): recebe o pedido, monta o evento e invoca B de forma assíncrona.
// Não valida o conteúdo de propósito — a validação é responsabilidade de B (ver E2).
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});
const CONSUMIDOR = process.env.CONSUMIDOR_FUNCTION;

export const handler = async (entrada) => {
  const evento = {
    pedido_id: entrada?.pedido_id,
    valor: entrada?.valor,
    cliente: entrada?.cliente,
    emitido_em: new Date().toISOString(),
  };

  const resp = await lambda.send(new InvokeCommand({
    FunctionName: CONSUMIDOR,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify(evento)),
  }));

  // Invoke assíncrono aceito retorna 202; qualquer outro status é falha de A.
  if (resp.StatusCode !== 202) {
    throw new Error(`invoke assíncrono de B retornou ${resp.StatusCode}`);
  }
  return { aceito: true, pedido_id: evento.pedido_id };
};
