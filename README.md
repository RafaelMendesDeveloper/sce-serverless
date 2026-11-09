# sce-serverless

Security Chaos Engineering em ambiente serverless (AWS Lambda + AWS FIS). Repositório dos experimentos do artigo **"O uso de Security Chaos Engineering para ambientes serverless"** (PPGCC/UFSC).

```
script de tráfego ──invoke──▶ Lambda A (produtor) ──invoke assíncrono──▶ Lambda B (consumidor) ──▶ S3
```

| Id | Pilar | Injeção (AWS FIS) | Controle testado |
|---|---|---|---|
| E1 | Confidencialidade | SSM Automation anexa `s3:*` em `*` ao papel de B | CloudTrail → EventBridge → SNS/log; rollback do runbook |
| E2 | Integridade | SSM Automation envia payloads adulterados a B | Schema estrito em B; alarme de rejeição |
| E3 | Disponibilidade/custo | `aws:lambda:invocation-error` / `invocation-add-delay` em B | Retries limitados, limite de concorrência, alarmes de custo |

Detalhes: [`docs/experimentos.md`](docs/experimentos.md). Resultados: [`resultados/resumo.md`](resultados/resumo.md).

## Estrutura

```
template.yaml              SAM: app, observabilidade, controles, detecção de IAM, FIS, SSM, Budget
src/produtor|consumidor/   Lambdas A e B (Node.js 22, arm64, SDK v3 do runtime)
ssm/                       runbooks SSM Automation do E1 e do E2 (incluídos via AWS::Include)
scripts/                   tráfego, estado estável, e2e, experimentos, fila, coleta, teardown
resultados/                um JSON por execução + resumo.md / resumo.csv / tabela2.csv / tabela3.csv
docs/experimentos.md       hipótese → injeção → observação → rollback de cada experimento
```

## Pré-requisitos

AWS CLI v2, SAM CLI, Node.js ≥ 20 e um perfil AWS **dedicado** chamado `sce`. Todos os scripts recusam rodar sem `AWS_PROFILE=sce`.

```bash
npm install                # só os clientes do AWS SDK v3, usados pelos scripts locais
export AWS_PROFILE=sce
```

## 1. Deploy

```bash
sam build
sam deploy --stack-name sce-serverless --region us-east-1 --resolve-s3 \
  --capabilities CAPABILITY_NAMED_IAM --tags projeto=sce-artigo \
  --parameter-overrides AlertEmail=<seu-email> --no-confirm-changeset
# confirme a assinatura do SNS no e-mail recebido
aws s3 cp <arquivo-de-teste> s3://<SensivelBucket>/confidencial/segredo.json   # alvo da sondagem do E1
```

Parâmetros opcionais:
- `ConcorrenciaReservadaB` (padrão 0, que não configura; exige cota de conta acima de 10);
- `MaxRetriesB` (padrão 2);
- `LimiteInvocacoesBMin` (padrão 450);
- `LimiteErroAPct` (padrão 5).

## 2. Validação e linha de base

```bash
node scripts/teste_e2e.mjs                       # válido grava; inválido é rejeitado e logado
node scripts/estado_estavel.mjs --duracao 600    # 10 min a 1 req/s -> resultados/estado_estavel.json
```

## 3. Experimentos

```bash
node scripts/rodar_experimento.mjs --exp E1 --rodada 1
node scripts/rodar_experimento.mjs --exp E2 --rodada 1
node scripts/rodar_experimento.mjs --exp E3-erro-100 --rodada 1 --taxa 5 --espera 300
# variantes do E3: E3-erro-50, E3-erro-100, E3-atraso
./scripts/fila.sh                                 # bateria completa em sequência
```

Cada execução:
1. gera tráfego de fundo;
2. inicia o experiment template;
3. acompanha o estado até o fim;
4. espera as métricas consolidarem;
5. grava `resultados/<exp>-r<n>-<timestamp>.json` com os dados brutos e a análise.

## 4. Resultados

```bash
node scripts/coletar.mjs --reanalisar   # refaz as análises (CloudTrail chega com atraso) e gera os resumos
```

## 5. Teardown

```bash
./scripts/teardown.sh
```

Ele executa, em ordem:
1. para a trilha;
2. remove qualquer política do E1 que tenha sobrado;
3. esvazia os buckets;
4. roda `sam delete` e apaga o stack de artefatos do SAM;
5. lista os recursos que ainda tenham a tag `projeto=sce-artigo`.

## Custos (us-east-1)

| Item | Custo |
|---|---|
| Ambiente parado (alarmes, métricas custom, trilha) | centavos/dia |
| Estado estável (10 min a 1 req/s) | ≈ US$ 0,003 |
| AWS FIS | US$ 0,10 por action-minute (E1 ≈ 2 min, E2 ≈ 1 min, E3 = 3 min por variante) |
| Bateria completa (3×E1, 3×E2, 3×E3-erro-100, 1×E3-erro-50, 1×E3-atraso) | ≈ US$ 2–3, quase tudo FIS |

Há um Budget de US$ 5/mês com alerta por e-mail.
