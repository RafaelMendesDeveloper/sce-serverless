# Resultados — Security Chaos Engineering em ambiente serverless

Gerado em 2026-11-09T02:38:28.244Z a partir de 11 execuções em `resultados/`. Média ± desvio-padrão amostral quando há ≥ 3 rodadas; valores individuais separados por "/" caso contrário.

## Tabela 2 — Desenho dos experimentos

| Id | Pilar | Falha injetada | Controle esperado | Métrica |
| --- | --- | --- | --- | --- |
| E1 | Confidencialidade | Política inline permissiva (s3:* em *) anexada ao papel de B via SSM Automation, com sondagem de leitura a um bucket fora do escopo | Detecção de mudança de IAM (CloudTrail → EventBridge → SNS + log); rollback automático do runbook | Detectado (s/n); MTTD; acesso indevido (s/n) e evidência em logs/CloudTrail; rollback ok |
| E2 | Integridade | Eventos adulterados entregues a B como se A estivesse comprometida (campo extra, tipo errado, valor fora da faixa; 10 de cada) | Validação de schema estrito em B; metric filter + alarme de rejeição | Taxa de rejeição por tipo; objetos indevidos no S3; alarme (s/n) e tempo até ele |
| E3 | Disponibilidade (custo) | aws:lambda:invocation-error em B (50% e 100%) e aws:lambda:invocation-add-delay (6 s > timeout) sob rajada de 5 req/s | MaximumRetryAttempts explícito; limite de concorrência; alarmes de invocações/min e de amplificação B/A; Budget (2ª linha) | Fator de multiplicação B/A; throttles; pico de concorrência; custo da janela e custo/hora; tempo até o alarme |

## Tabela 3 — Resultados

| Id | Hipótese confirmada? | Detectado? | Tempo de detecção | Observação |
| --- | --- | --- | --- | --- |
| E1 | 3/3 | 3/3 | 2,5 ± 0,5 s | Acesso indevido bem-sucedido em 3/3; rollback ok em 3/3; detecção antes do rollback em 3/3; janela de exposição 81,8 ± 0,1 s |
| E2 | 3/3 | 3/3 | 77,1 ± 8,8 s (alarme) | Rejeição 100,0 ± 0,0%; objetos indevidos no S3: 0/0/0 |
| E3-erro-100 | 3/3 | 3/3 | 61,7 ± 11,9 s (alarme de custo) | Fator B/A 1,96 ± 0,03 (pico por minuto 2,74 ± 0,12) (estado estável 1,00); custo/pedido 1,03 ± 0,01× o estável; throttles A/B 0/0, 0/0, 0/0; pico de concorrência 7/6/6 |
| E3-erro-50 | 1/1 | 1/1 | 60,5 s (alarme de custo) | Fator B/A 1,37 (pico por minuto 1,55) (estado estável 1,00); custo/pedido 1,01× o estável; throttles A/B 0/0; pico de concorrência 4 |
| E3-atraso | 1/1 | 1/1 | 47,6 s (alarme de custo) | Fator B/A 1,93 (pico por minuto 2,39) (estado estável 1,00); custo/pedido 2,44× o estável; throttles A/B 0/0; pico de concorrência 87 |

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
| 2 | sim | 2,1 | 2,2 | 81,7 | negado/permitido/negado | sim | sim | sim | completed |
| 3 | sim | 2,5 | 2,3 | 81,8 | negado/permitido/negado | sim | sim | sim | completed |

## E2 — Payload adulterado (por execução)

| Rodada | Rejeição campo extra | Rejeição tipo errado | Rejeição fora da faixa | Objetos indevidos S3 | Alarme | Tempo até alarme (s) | 1ª rejeição (s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 10/10 | 10/10 | 10/10 | 0 | sim | 87,3 | 2,6 |
| 2 | 10/10 | 10/10 | 10/10 | 0 | sim | 72,3 | 2,0 |
| 3 | 10/10 | 10/10 | 10/10 | 0 | sim | 71,7 | 2,0 |

## E3 — Denial of Wallet (por execução)

| Variante | Rodada | Inv. A | Inv. B | Fator B/A | Fator pico/min | Throttles A/B | Pico conc. B | Descartados B | Custo janela (US$) | Custo/h (US$) | Custo/pedido vs estável | Alarme invoc. (s) | Alarme amplif. (s) | Estado FIS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E3-erro-100 | 1 | 1483 | 2886 | 1,95 | 2,81 | 0/0 | 7 | 2 | 0.00855 | 0.0646 | 1,04× | 67,7 | 121,2 | completed |
| E3-erro-100 | 2 | 1484 | 2952 | 1,99 | 2,61 | 0/0 | 6 | 13 | 0.00848 | 0.0640 | 1,03× | 48,0 | 101,5 | completed |
| E3-erro-100 | 3 | 1486 | 2884 | 1,94 | 2,81 | 0/0 | 6 | 4 | 0.00852 | 0.0643 | 1,03× | 69,5 | 122,9 | completed |
| E3-erro-50 | 1 | 1435 | 1967 | 1,37 | 1,55 | 0/0 | 4 | 2 | 0.00804 | 0.0620 | 1,01× | 60,5 | 234,0 | completed |
| E3-atraso | 1 | 1482 | 2862 | 1,93 | 2,39 | 0/0 | 87 | 0 | 0.02013 | 0.1521 | 2,44× | 47,6 | 161,2 | completed |

Obs.: o AWS Budgets não é atualizado em tempo real; ele foi mantido como controle de segunda linha e não foi usado como métrica.

