# sce-serverless — regras do projeto

Experimentos de Security Chaos Engineering em ambiente serverless (AWS SAM, us-east-1) para artigo de mestrado (UFSC).

## Commits
- **Nenhuma atribuição a Claude/IA**: sem `Co-Authored-By`, sem "Generated with Claude Code", sem links de sessão, sem emojis.
- Mensagens curtas, em português, no imperativo (ex.: `adiciona template do experimento E1`).
- `.claude/settings.json` mantém `{"attribution": {"commit": "", "pr": ""}}` — não alterar.
- Nunca commitar credenciais, `samconfig.toml`, `.aws-sam/` ou `node_modules/`.

## AWS
- **Usar somente o perfil `sce`** (conta pessoal criada para o artigo): todo comando com `--profile sce` / `AWS_PROFILE=sce`. Os perfis `default`, `dev`, `sandbox`, `local` e `prod` são da empresa — **nunca** usar.
- Região `us-east-1`, stack único `sce-serverless`, tag `projeto=sce-artigo` em tudo, logs com retenção de 1 dia.
- Antes de qualquer comando que crie recurso pago ou inicie experimento FIS: mostrar o comando e o custo estimado e esperar ok.
- Experimentos FIS curtos (2–5 min), sempre com condição de parada e rollback.
- Teardown: `scripts/teardown.sh`.

## Código
- Node.js 22 (`nodejs22.x`, arm64, 128 MB, timeout ≤ 10 s), ESM, só AWS SDK v3 (sem bundler, sem outras dependências).
