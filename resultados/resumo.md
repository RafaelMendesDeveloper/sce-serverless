# Resultados — Security Chaos Engineering em ambiente serverless

Gerado em 2026-11-09T00:55:25.087Z a partir de 1 execuções em `resultados/`. Média ± desvio-padrão amostral quando há ≥ 3 rodadas; valores individuais separados por "/" caso contrário.

## Tabela 2 — Desenho dos experimentos

| Id | Pilar | Falha injetada | Controle esperado | Métrica |
| --- | --- | --- | --- | --- |
| E1 | Confidencialidade | Política inline permissiva (s3:* em *) anexada ao papel de B via SSM Automation, com sondagem de leitura a um bucket fora do escopo | Detecção de mudança de IAM (CloudTrail → EventBridge → SNS + log); rollback automático do runbook | Detectado (s/n); MTTD; acesso indevido (s/n) e evidência em logs/CloudTrail; rollback ok |
| E2 | Integridade | Eventos adulterados entregues a B como se A estivesse comprometida (campo extra, tipo errado, valor fora da faixa; 10 de cada) | Validação de schema estrito em B; metric filter + alarme de rejeição | Taxa de rejeição por tipo; objetos indevidos no S3; alarme (s/n) e tempo até ele |
| E3 | Disponibilidade (custo) | aws:lambda:invocation-error em B (50% e 100%) e aws:lambda:invocation-add-delay (6 s > timeout) sob rajada de 5 req/s | MaximumRetryAttempts explícito; limite de concorrência; alarmes de invocações/min e de amplificação B/A; Budget (2ª linha) | Fator de multiplicação B/A; throttles; pico de concorrência; custo da janela e custo/hora; tempo até o alarme |

## Tabela 3 — Resultados

| Id | Hipótese confirmada? | Detectado? | Tempo de detecção | Observação |
| --- | --- | --- | --- | --- |
| E1 | 1/1 | 1/1 | 3,0 s | Acesso indevido bem-sucedido em 1/1; rollback ok em 1/1; detecção antes do rollback em 1/1; janela de exposição 81,9 s |

## Estado estável (linha de base)

| Métrica | A (produtor) | B (consumidor) |
| --- | --- | --- |
| Invocações | 600 | 600 |
| Erros | 0 | 0 |
| Throttles | 0 | 0 |
| Duração média (ms) | 35,8 | 59,9 |
| Duração p95 (ms) | 88,2 | 127,1 |
| Pico de concorrência | 1 | 1 |

Janela de 10 min a 1 req/s; fator B/A 1,00; rejeições 0; gravados 600; latência no cliente 206,0 ms (p95 272,3 ms); custo estimado US$ 0.00334 na janela, **US$ 0.0200/h**.

## E1 — Permissão excessiva (por execução)

| Rodada | Detectado | MTTD (s) | Detecção do rollback (s) | Exposição (s) | Acesso antes/durante/depois | Visível logs B | Visível CloudTrail | Rollback ok | Estado FIS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | sim | 3,0 | 2,1 | 81,9 | negado/permitido/negado | sim | sim | sim | completed |

