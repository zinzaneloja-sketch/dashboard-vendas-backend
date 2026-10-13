#!/usr/bin/env bash
# Envia a planilha "Estoque Omni" (.xlsx) para o painel (menu Estoque Cia) e espera o
# processamento terminar. Usado pela rotina .github/workflows/estoque-cia.yml, mas também
# roda à mão:
#   ESTOQUE_UPLOAD_KEY=xxxx ./scripts/enviar-estoque.sh estoque/Estoque_Omni_2026-10-13.xlsx
# Variáveis:
#   ESTOQUE_UPLOAD_KEY  (obrigatória) mesma chave configurada no Railway
#   ESTOQUE_API_URL     (opcional) padrão: backend de produção
#   ESTOQUE_DATA        (opcional) data do estoque AAAA-MM-DD; sem ela, usa a data do nome
#                       do arquivo ou o dia de hoje
set -euo pipefail
ARQ="${1:?Informe o caminho do .xlsx}"
API="${ESTOQUE_API_URL:-https://dashboard-vendas-backend-production.up.railway.app}"
KEY="${ESTOQUE_UPLOAD_KEY:?Defina ESTOQUE_UPLOAD_KEY}"
NOME="$(basename "$ARQ")"
NOME_URL="$(printf '%s' "$NOME" | jq -sRr @uri)"
QS="arquivo=${NOME_URL}"
[ -n "${ESTOQUE_DATA:-}" ] && QS="${QS}&data=${ESTOQUE_DATA}"

echo "Enviando ${NOME} ($(du -h "$ARQ" | cut -f1)) para ${API}…"
RESP="$(curl -sS --fail-with-body -X POST \
  -H "X-Estoque-Key: ${KEY}" -H "Content-Type: application/octet-stream" \
  --data-binary @"$ARQ" "${API}/api/estoque-cia/upload?${QS}")"
echo "$RESP"

for i in $(seq 1 60); do
  sleep 5
  ST="$(curl -sS -H "X-Estoque-Key: ${KEY}" "${API}/api/estoque-cia/status")"
  STATUS="$(echo "$ST" | jq -r '.job.status // "?"')"
  if [ "$STATUS" = "ok" ]; then
    echo "$ST" | jq -r '.job.result | "Pronto: estoque de \(.dataRef) com \(.pecas) peças, \(.refs) referências e \(.locais) locais."'
    exit 0
  elif [ "$STATUS" = "error" ]; then
    echo "Erro ao processar: $(echo "$ST" | jq -r '.job.error')" >&2
    exit 1
  fi
  echo "Processando… (${i})"
done
echo "Ainda processando depois de 5 minutos. Confira em Estoque Cia → Carregar planilha." >&2
exit 1
