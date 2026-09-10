#!/usr/bin/env bash
set -euo pipefail

ORDER_ID="${MERCARI_ORDER_ID:-2JPDfQ5MRbUFVsc3ZLH4FR}"
SHOP_LABEL="${MERCARI_SHOP_LABEL:-Shop4}"
TOKEN_FILE="${MERCARI_TOKENS_PATH:-/Users/user/Documents/April 2026/Mercari API testing/knowledge/Mercari_API_Tokens_Private_2026-04-01.md}"
SSH_HOST="${MERCARI_SSH_HOST:-root@160.251.141.110}"
SSH_KEY="${MERCARI_SSH_KEY:-/Users/user/.ssh/id_ed25519}"

TOKEN="$(
  grep -A4 "^## ${SHOP_LABEL}$" "$TOKEN_FILE" \
    | grep 'API token:' \
    | sed -n 's/.*`\\([^`]*\\)`.*/\\1/p' \
    | head -n 1
)"

REQUEST_BODY="$(cat <<'JSON'
{"query":"query orderTransactions($first: Int!, $statuses: [OrderTransactionStatusFilter!]) { orderTransactions(first: $first, statuses: $statuses) { edges { node { id status products { productId purchasedQuantity unshippedQuantity shippingMethod variant { id skuCode } } shipping { id status method trackingCode completedAt shippedAt } } } } }","variables":{"first":10,"statuses":["WAITING_FOR_SHIPPING","COMPLETED","WAITING_FOR_PAYMENT","COMPLETING"]}}
JSON
)"

if [[ "${DEBUG_RAW:-}" == "1" ]]; then
  ssh -o BatchMode=yes -i "$SSH_KEY" "$SSH_HOST" env \
    "MERCARI_ACCESS_TOKEN=$TOKEN" \
    "MERCARI_API_CLIENT_NAME=Inhouse_ERP" \
    "MERCARI_API_CLIENT_VERSION=0.0.1" \
    "REQUEST_BODY=$REQUEST_BODY" \
    bash -s <<'EOS'
set -euo pipefail
curl -4 -sS -X POST 'https://api.mercari-shops.com/v1/graphql' \
  -H "Authorization: Bearer $MERCARI_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $MERCARI_API_CLIENT_NAME/$MERCARI_API_CLIENT_VERSION" \
  --data-binary "$REQUEST_BODY"
EOS
else
  ssh -o BatchMode=yes -i "$SSH_KEY" "$SSH_HOST" env \
    "MERCARI_ACCESS_TOKEN=$TOKEN" \
    "MERCARI_API_CLIENT_NAME=Inhouse_ERP" \
    "MERCARI_API_CLIENT_VERSION=0.0.1" \
    "REQUEST_BODY=$REQUEST_BODY" \
    bash -s <<'EOS' | jq --arg order_id "$ORDER_ID" '.data.orderTransactions.edges[].node | select(.id == $order_id)'
set -euo pipefail
curl -4 -sS -X POST 'https://api.mercari-shops.com/v1/graphql' \
  -H "Authorization: Bearer $MERCARI_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "User-Agent: $MERCARI_API_CLIENT_NAME/$MERCARI_API_CLIENT_VERSION" \
  --data-binary "$REQUEST_BODY"
EOS
fi
