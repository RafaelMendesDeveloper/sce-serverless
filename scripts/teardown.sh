#!/usr/bin/env bash
# Destrói tudo do projeto: para a trilha, remove política de E1 remanescente,
# esvazia os buckets, apaga o stack e o stack de artefatos do SAM, e confere as tags.
# Uso: AWS_PROFILE=sce ./scripts/teardown.sh
set -uo pipefail

if [[ "${AWS_PROFILE:-}" != "sce" ]]; then
  echo "Defina AWS_PROFILE=sce (perfis da empresa não podem ser usados)." >&2
  exit 1
fi
export AWS_REGION=us-east-1
STACK=sce-serverless

saida() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null
}

esvaziar_bucket() { # apaga objetos e versões (se houver)
  local b="$1"
  [[ -z "$b" || "$b" == "None" ]] && return
  echo "  esvaziando s3://$b"
  aws s3 rm "s3://$b" --recursive --quiet || true
  while :; do
    local json
    json=$(aws s3api list-object-versions --bucket "$b" --max-items 500 \
      --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][] }' \
      --output json 2>/dev/null) || break
    [[ "$(echo "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log((o.Objects||[]).filter(Boolean).length)})')" == "0" ]] && break
    echo "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(JSON.stringify({Objects:(o.Objects||[]).filter(Boolean),Quiet:true}))})' > /tmp/sce-del.json
    aws s3api delete-objects --bucket "$b" --delete file:///tmp/sce-del.json >/dev/null || break
  done
}

echo "1) parando a trilha do CloudTrail"
aws cloudtrail stop-logging --name sce-trilha 2>/dev/null && echo "  ok" || echo "  (trilha não encontrada)"

echo "2) removendo política inline do E1 que tenha sobrado"
aws iam delete-role-policy --role-name sce-consumidor-role --policy-name sce-e1-permissiva 2>/dev/null \
  && echo "  removida" || echo "  (nenhuma)"

echo "3) esvaziando buckets do stack"
for k in DadosBucket SensivelBucket FisConfigBucket TrilhaBucket; do esvaziar_bucket "$(saida $k)"; done

echo "4) apagando o stack $STACK"
sam delete --stack-name "$STACK" --region "$AWS_REGION" --no-prompts

echo "5) apagando o stack de artefatos do SAM (aws-sam-cli-managed-default)"
SAMB=$(aws cloudformation describe-stacks --stack-name aws-sam-cli-managed-default \
  --query "Stacks[0].Outputs[?OutputKey=='SourceBucket'].OutputValue" --output text 2>/dev/null)
if [[ -n "$SAMB" && "$SAMB" != "None" ]]; then
  esvaziar_bucket "$SAMB"
  aws cloudformation delete-stack --stack-name aws-sam-cli-managed-default
  aws cloudformation wait stack-delete-complete --stack-name aws-sam-cli-managed-default && echo "  ok"
else
  echo "  (não existe)"
fi

echo "6) recursos remanescentes com a tag projeto=sce-artigo:"
aws resourcegroupstaggingapi get-resources --tag-filters Key=projeto,Values=sce-artigo \
  --query 'ResourceTagMappingList[].ResourceARN' --output text
echo "   (vazio = nada sobrou; o índice de tags pode levar alguns minutos para atualizar)"
echo "   Budget 'sce-artigo-5usd' é removido junto com o stack."
