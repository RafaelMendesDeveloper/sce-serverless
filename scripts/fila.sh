#!/usr/bin/env bash
# Executa a bateria de experimentos em sequência (um por vez, para não contaminar as métricas).
# Uso: AWS_PROFILE=sce ./scripts/fila.sh
# Ordem: E3-atraso por último porque gera throttling e uma cauda longa de retries assíncronos.
set -uo pipefail
[[ "${AWS_PROFILE:-}" == "sce" ]] || { echo "Defina AWS_PROFILE=sce" >&2; exit 1; }
cd "$(dirname "$0")/.."

FILA=(
  "E1 2 1 180"
  "E1 3 1 180"
  "E2 1 1 180"
  "E2 2 1 180"
  "E2 3 1 180"
  "E3-erro-100 1 5 300"
  "E3-erro-100 2 5 300"
  "E3-erro-100 3 5 300"
  "E3-erro-50 1 5 300"
  "E3-atraso 1 5 300"
)
for item in "${FILA[@]}"; do
  read -r exp rodada taxa espera <<<"$item"
  echo "=================== $(date -u +%T) $exp rodada $rodada (taxa $taxa, espera $espera)"
  # E1/E2: se a condição de parada estiver em ALARM, o FIS recusa iniciar - aguarda voltar a OK
  for _ in $(seq 1 20); do
    st=$(aws cloudwatch describe-alarms --alarm-names sce-erro-a-alto --region us-east-1 --query 'MetricAlarms[0].StateValue' --output text)
    [[ "$st" != "ALARM" ]] && break
    echo "  condição de parada em ALARM; aguardando 30 s"; sleep 30
  done
  node scripts/rodar_experimento.mjs --exp "$exp" --rodada "$rodada" --taxa "$taxa" --espera "$espera" \
    2>&1 | grep -vE '^\s' | grep -v '^[{}]'
  echo "  $exp r$rodada terminou com código ${PIPESTATUS[0]}"
  sleep 20
done
echo "=================== $(date -u +%T) fila concluída"
