# Experimentos de Security Chaos Engineering em ambiente serverless

Este documento descreve o ambiente e os três experimentos no roteiro **hipótese → injeção → observação → rollback**. O texto pode ser adaptado diretamente para o artigo. Os números citados estão em `resultados/resumo.md` (gerado por `scripts/coletar.mjs`).

## 1. Ambiente experimental

A aplicação-alvo é um fluxo assíncrono mínimo, típico de arquiteturas orientadas a eventos na AWS:

```
gerador de tráfego ──Invoke──▶ Lambda A (produtor) ──Invoke assíncrono──▶ Lambda B (consumidor) ──▶ S3 (dados/)
```

- **Lambda A** (`sce-produtor`) recebe um pedido `{pedido_id, valor, cliente}`, acrescenta `emitido_em` e invoca B com `InvocationType=Event`. A não valida o conteúdo; a validação é responsabilidade de B.
- **Lambda B** (`sce-consumidor`) aplica um schema estrito: os quatro campos são obrigatórios, os tipos são verificados, `valor` deve estar em [0,01; 10.000], `pedido_id` deve casar com `^[A-Za-z0-9-]{1,64}$` e campos extras não são aceitos. Um evento válido é gravado em `s3://<dados>/dados/<pedido_id>.json`. Um evento inválido é descartado e gera o log estruturado `{"evento":"payload_rejeitado","motivo":...}`.
- **Configuração comum**: Node.js 22 (`nodejs22.x`) em arm64, 128 MB, timeout de 5 s, região `us-east-1`. A infraestrutura é declarada como código (AWS SAM) em um único stack. Os logs têm retenção de 1 dia e todos os recursos levam a tag `projeto=sce-artigo`.
- **Privilégio mínimo**: papéis IAM separados. A só pode `lambda:InvokeFunction` em B. B só pode `s3:PutObject`/`s3:GetObject` em `dados/*` do bucket de dados, além da leitura do prefixo de configuração exigido pela extensão do AWS FIS.
- **Controles de segurança e resiliência**:
  - invocação assíncrona de B com `MaximumRetryAttempts = 2` e `MaximumEventAgeInSeconds = 600` declarados explicitamente;
  - metric filter `payload_rejeitado` → métrica `SCE/PayloadRejeitado` → alarme `sce-rejeicao-payload` (≥ 1 em 1 min);
  - alarme de invocações de B acima de 450/min (`sce-invocacoes-b-alto`) e alarme de amplificação Invocações(B)/Invocações(A) > 1,5 (`sce-amplificacao-b`), como sinais antecipados de custo;
  - alarme de taxa de falha de A, (erros + throttles)/(invocações + throttles) > 5% (`sce-erro-a-alto`), usado como **condição de parada** de todos os experimentos FIS;
  - trilha do CloudTrail (eventos de gerenciamento e *data events* apenas do bucket sensível) e regra do EventBridge para `AttachRolePolicy`, `PutRolePolicy`, `DetachRolePolicy` e `DeleteRolePolicy` no papel de B, com alvos SNS (`sce-alertas`, e-mail) e um log group de detecções (`/aws/events/sce/deteccoes`);
  - AWS Budgets de US$ 5/mês como controle de segunda linha (não é atualizado em tempo real).
- **Injeção de falhas**: AWS Fault Injection Service (FIS). E1 e E2 usam a ação `aws:ssm:start-automation-execution` com runbooks SSM Automation próprios. E3 usa as ações nativas `aws:lambda:invocation-error` e `aws:lambda:invocation-add-delay`, que dependem da extensão do FIS para Lambda anexada como layer em B (`AWS_LAMBDA_EXEC_WRAPPER=/opt/aws-fis/bootstrap`, configuração via S3). A extensão também estava presente durante a medição do estado estável, para que a linha de base seja comparável.
- **Estado estável**: 10 min de tráfego a 1 req/s. Cada experimento roda com tráfego de fundo (1 req/s em E1/E2 e rajada de 5 req/s em E3), que começa 30 s antes da injeção e termina 60 s depois do fim do experimento.

## 2. E1 — Confidencialidade: permissão excessiva

- **Hipótese.** Se uma política com curinga (`s3:*` em `*`) for anexada ao papel de B, o mecanismo de detecção (CloudTrail → EventBridge) registra o evento em até X minutos, antes que o rollback remova a permissão. X é a grandeza medida (MTTD).
- **Injeção.** O FIS inicia o runbook `ssm/e1-permissao-excessiva.yaml`, que executa:
  1. *sondagem de controle*: invoca B com um evento especial que tenta ler `confidencial/segredo.json` de um segundo bucket "sensível", fora do escopo do papel; o esperado é `AccessDenied`;
  2. *injeção*: `iam:PutRolePolicy` com a política inline `sce-e1-permissiva`;
  3. espera de 20 s para a propagação do IAM;
  4. *exploração*: nova sondagem, que simula um atacante com execução de código em B;
  5. *janela de exposição* de 1 min.
- **Observação.**
  - **MTTD**: diferença entre o fim da chamada `PutRolePolicy` (registrada pelo SSM) e o instante de ingestão do evento no log group de detecções.
  - **Acesso indevido**: resultado da sondagem durante a exposição.
  - **Visibilidade**: o acesso aparece nos logs estruturados de B (`sondagem_acesso`) e nos *data events* do CloudTrail (`GetObject` pelo papel de B, com `errorCode` nos acessos negados).
- **Rollback.** O passo `RemoverPolitica` (`iam:DeleteRolePolicy`) roda em qualquer caso: todos os passos posteriores à injeção têm `onFailure` e `onCancel` apontando para ele. Assim, o rollback ocorre mesmo que o FIS interrompa a automação pela condição de parada. Depois de mais 20 s, uma sondagem final verifica que o acesso voltou a ser negado. O script de análise confirma no IAM que a política não existe mais, e o teardown também a remove como terceira linha de defesa.
- **Resultados (n = 3).**
  - A detecção ocorreu em 3/3 rodadas, com **MTTD de 2,5 ± 0,5 s**. A detecção do rollback (`DeleteRolePolicy`) levou cerca de 2,2 s.
  - Nas três rodadas, o acesso ao bucket sensível foi negado antes da injeção, **permitido durante a exposição** (≈ 82 s) e negado de novo após o rollback.
  - O acesso indevido aparece tanto nos logs de B quanto nos *data events* do CloudTrail (sequência `AccessDenied` → sucesso → `AccessDenied`, atribuída ao papel `sce-consumidor-role`).
  - Rollback ok em 3/3, e a detecção sempre chegou antes do rollback.
  - **Leitura crítica:** a detecção é rápida, mas apenas **detectiva**. Durante os cerca de 80 s de exposição, o dado sensível foi lido. Sem uma resposta automática (por exemplo, uma Lambda acionada pelo EventBridge que reverta a política), o tempo de exposição real depende do tempo de reação humana ao e-mail.
- **Lições de implementação.**
  - (i) Para a ação `aws:ssm:start-automation-execution`, a permissão `ssm:StartAutomationExecution` do papel do FIS é avaliada contra três recursos: `document/`, `automation-definition/` e `automation-execution/`. Duas execuções falharam com `AccessDenied` até isso ser identificado no CloudTrail. Ambas estão em `resultados/falhas/` e nenhuma chegou à injeção.
  - (ii) O SSM não aceita `aws:sleep` no fluxo de cancelamento, por isso a espera pós-rollback usa `aws:executeScript`.

## 3. E2 — Integridade: payload adulterado

- **Hipótese.** Se B receber eventos adulterados, como se A estivesse comprometida, B rejeita 100% deles, não grava nada no S3 e o alarme de rejeição dispara.
- **Injeção.** O FIS inicia o runbook `ssm/e2-payload-adulterado.yaml`. Um passo `aws:executeScript` invoca B de forma assíncrona, pelo mesmo caminho que A usa, com 10 eventos de cada tipo:
  - **campo extra malicioso**: `is_admin: true` e `destino: "s3://bucket-do-atacante/exfil/"`;
  - **tipo errado**: `valor: "10.00"` como string;
  - **valor fora da faixa**: `valor: 99999999`.

  Cada `pedido_id` carrega uma marca da execução, o que permite contar rejeições por tipo e localizar objetos indevidos.
- **Observação.** Medimos:
  - taxa de rejeição por tipo (logs `payload_rejeitado` correlacionados pelo `pedido_id`);
  - número de objetos `dados/e2-*-<marca>.json` no S3 (o esperado é 0);
  - transição do alarme `sce-rejeicao-payload` para ALARM e o tempo desde o início da injeção.
- **Rollback.** Não há estado a reverter: os eventos adulterados apenas geram rejeições e logs. O tráfego legítimo de fundo continua sendo gravado normalmente.
- **Resultados (n = 3, após a correção descrita abaixo).**
  - B rejeitou 100% dos 90 eventos adulterados, com o motivo correto em cada tipo: `campo_extra:is_admin,destino`, `tipo_invalido:valor` e `fora_da_faixa:valor`.
  - Nenhum objeto indevido foi gravado no S3 (0/0/0).
  - A primeira rejeição ocorreu cerca de 2 s após a injeção, e o alarme disparou em **77,1 ± 8,8 s**, latência dominada pelo período de 1 min da métrica e do alarme.
- **Achado (falha do controle revelada pelo experimento).** Na primeira bateria, o alarme de rejeição disparou na rodada 1 e não voltou mais para OK. O metric filter não tinha `DefaultValue`, então a métrica era esparsa: sem pontos novos, o CloudWatch manteve o último estado, ALARM. Com isso, as rodadas 2 e 3 não geraram nenhum alerta novo, embora B tenha rejeitado 30/30 eventos em cada uma. Em produção, isso significa que **apenas o primeiro ataque seria notificado**. A correção foi `DefaultValue: 0`, que publica 0 a cada log não casado, e as rodadas 2 e 3 foram refeitas. As execuções descartadas estão em `resultados/falhas/`.

## 4. E3 — Disponibilidade: Denial of Wallet

- **Hipótese.** Com B falhando, os retries assíncronos multiplicam as invocações e o custo. Mesmo assim, o limite de concorrência contém o pico e os alarmes de custo disparam antes que o custo/hora ultrapasse Y vezes o do estado estável.
- **Injeção.** Três variantes, cada uma com 3 min de duração e rajada de 5 req/s:
  - `aws:lambda:invocation-error` com `invocationPercentage = 100` e `preventExecution = true` (3 rodadas);
  - a mesma ação com `invocationPercentage = 50` (1 rodada);
  - `aws:lambda:invocation-add-delay` com 6.000 ms, acima do timeout de 5 s: cada invocação vira um timeout cobrado por 5 s e gera retry (1 rodada).
- **Observação.** Na janela do tráfego, mais 3 min para os retries (que ocorrem cerca de 1 e 2 min após cada falha), medimos:
  - fator de multiplicação Invocações(B)/Invocações(A), comparado com o estado estável;
  - throttles de A e de B;
  - pico de `ConcurrentExecutions` de B;
  - eventos descartados após esgotar os retries (`AsyncEventsDropped`);
  - custo estimado da janela, custo/hora projetado e custo por pedido comparado ao estado estável (Lambda arm64 por GB-s + requests + PUTs no S3, sem free tier);
  - tempo até cada alarme (histórico do CloudWatch).

  O AWS Budgets fica registrado como controle de segunda linha e não é usado como métrica, pois tem atraso de horas.
- **Rollback.** O próprio FIS remove a configuração de falha do bucket S3 de configuração ao fim da ação. A extensão deixa de injetar em até cerca de 20 s, o intervalo de *hot polling*. A condição de parada interrompe o experimento se a taxa de falha de A passar de 5%.
- **Cota de concorrência e variantes.** A conta nova tinha cota de 10 execuções concorrentes de Lambda, e a AWS exige uma sobra mínima de concorrência não reservada. Por isso, não foi possível reservar concorrência em B no início. As variantes `E3-erro-*` rodaram sob esse teto de 10, compartilhado entre A e B. A cota foi elevada para 1000 durante a bateria. A partir daí, `E3-atraso` rodou **sem** limite efetivo, e `E3-atraso-rc` repetiu o mesmo atraso **com** `ReservedConcurrentExecutions = 5` em B. Os throttles de A entram na condição de parada justamente para capturar o efeito *noisy neighbor*, em que a degradação de B consome a concorrência de A.

### 4.1 Resultados e discussão do E3

- **Erro rápido** (`invocation-error`, `preventExecution = true`).
  - O fator B/A subiu de 1,00 para 1,96 ± 0,03 na janela inteira (100%, n = 3). No pior minuto, chegou a 2,74 ± 0,12×, próximo do teórico de 3× (1 tentativa + 2 retries).
  - Com 50% de falha, o fator foi 1,37 (pico de 1,55×; teórico: 1 + 0,5 + 0,25 = 1,75×).
  - O custo por pedido mal mudou (1,01–1,04×), porque uma invocação que falha antes de executar dura poucos milissegundos.
  - Poucos eventos foram descartados, pois os retries tardios (até cerca de 3,4 min) caíram depois do fim da falha.
  - O alarme absoluto de invocações foi o sinal mais rápido: 61,7 ± 11,9 s com 100% e 60,5 s com 50%. O alarme de amplificação demorou mais, porque os retries chegam com atraso de 1 a 2 min. Com 50%, ele quase não cruzou o limiar de 1,5.
- **Falha lenta** (`invocation-add-delay` de 6 s, acima do timeout de 5 s). É aqui que o *Denial of Wallet* aparece.
  - Sem limite de concorrência, B escalou até 87 execuções simultâneas e consumiu 889 GB-s, contra cerca de 18 no erro rápido.
  - O custo por pedido chegou a 2,44× e o custo/hora a 7,6× o estado estável.
  - O alarme de invocações disparou em 47,6 s.
- **Mesma falha lenta com concorrência reservada = 5.**
  - O pico ficou em 5 e o consumo caiu para 90 GB-s (−90%). O custo por pedido ficou em 1,12×, e nenhum pedido foi perdido: 1.481/1.481 gravados, 0 descartados.
  - Houve dois efeitos colaterais. (i) B sofreu 2.366 throttles, e os eventos represados na fila assíncrona atingiram 492 s de idade, perto do `MaximumEventAgeInSeconds` de 600 s. Uma falha um pouco mais longa resultaria em **descarte silencioso de eventos**. (ii) Throttle não conta como invocação, então os alarmes de custo **só dispararam quando a fila drenou**, cerca de 4 min após a injeção e depois do fim da falha.
  - Em resumo, o controle preventivo de custo funcionou, mas reduziu a observabilidade do controle detectivo. Daí a recomendação de alarmar também `Throttles` e `AsyncEventAge` de B e de configurar um destino `OnFailure`/DLQ para os eventos descartados.
- **Avaliação da hipótese.** Ela é confirmada para as variantes sem reserva: houve amplificação e o alarme disparou antes do fim da falha. Na variante com reserva, é **parcialmente confirmada**: o limite de concorrência conteve o pico e o custo, mas o alarme chegou tarde. Em nenhuma variante a condição de parada foi acionada, porque A não sofreu erros nem throttles.

## 5. Ameaças à validade

- **Volume de dados.** Tráfego sintético e de baixa taxa, com 1 a 3 rodadas por experimento. O desvio-padrão é reportado apenas com n ≥ 3.
- **Natureza do MTTD.** O MTTD medido é o da **detecção registrada** (ingestão no log group). A entrega do e-mail via SNS não foi cronometrada. A AWS descreve a entrega de eventos de serviço via CloudTrail ao EventBridge como *best effort*.
- **Precisão dos instantes.** O instante da injeção vem do SSM (resolução de milissegundos), enquanto `eventTime` do CloudTrail tem resolução de segundos.
- **Custos.** São estimativas a partir de métricas do CloudWatch e preços públicos (us-east-1), sem free tier e sem o custo do próprio FIS (US$ 0,10 por action-minute).
- **Escopo.** Uma única região e conta. A extensão do FIS adiciona *overhead* a B, presente também na linha de base.
