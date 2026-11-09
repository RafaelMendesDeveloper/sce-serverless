# Execuções descartadas

Ficam fora da consolidação (`coletar.mjs` só lê `resultados/E*.json`). Os registros brutos foram mantidos como evidência.

| Arquivo | Motivo | Correção |
|---|---|---|
| `E1-r1-2026-11-09T00-35-12-159Z.json` | FIS falhou ao iniciar a automação: `AccessDenied` em `ssm:StartAutomationExecution` sobre `document/sce-e1-permissao-excessiva`. Nenhuma injeção ocorreu. | Incluído `document/sce-*` na política do papel do FIS. |
| `E1-r1-2026-11-09T00-41-50-438Z.json` | Mesmo erro, agora sobre `automation-execution/*`. Nenhuma injeção ocorreu. | Incluído `automation-execution/*` no `StartAutomationExecution`. |
| `E2-r2-*.json`, `E2-r3-*.json` (1ª tentativa) | O alarme `sce-rejeicao-payload` ficou preso em ALARM desde a r1. O metric filter não tinha `DefaultValue`, então a métrica era esparsa: sem pontos novos, o CloudWatch manteve o último estado. Não houve transição OK→ALARM para medir. A validação, por outro lado, funcionou: 30/30 rejeitados e 0 objetos no S3. | `DefaultValue: 0` nos metric filters; o E2 r2/r3 foi refeito. |

**Lição para o artigo:** um controle de detecção baseado em metric filter sem `DefaultValue` só alerta a **primeira** ocorrência e depois fica "cego". Um ataque contínuo ou repetido não geraria novos alertas. O próprio experimento de caos revelou essa falha de configuração do controle.
