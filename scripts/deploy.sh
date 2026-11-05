#!/usr/bin/env bash
# Deploys the relay with the one Cloudflare token saved in this repository.
# Run by .github/workflows/deploy.yml. Creates what is missing, so a first run
# on an empty free account needs no other step. Writes relay-url.txt.
set -euo pipefail

NAME=week-counts
API=https://api.cloudflare.com/client/v4
export CI=true WRANGLER_SEND_METRICS=false

api() { curl -sS --fail-with-body -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }

# The account: the Actions variable if it is set, else the one the token reaches.
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID="$(api "$API/accounts" | jq -r 'if (.result | length) == 1 then .result[0].id else empty end')"
fi
if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
  echo "The token reaches no single account. Set the Actions variable CLOUDFLARE_ACCOUNT_ID." >&2
  exit 1
fi
export CLOUDFLARE_ACCOUNT_ID
echo "::add-mask::$CLOUDFLARE_ACCOUNT_ID"

# The workers.dev name. An account that has none gets a neutral one.
subdomain="$(api "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" 2>/dev/null | jq -r '.result.subdomain // empty' || true)"
if [ -z "$subdomain" ]; then
  subdomain="${RELAY_SUBDOMAIN:-open-carrier-week}"
  if ! answer="$(api -X PUT "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" --data "{\"subdomain\":\"$subdomain\"}")"; then
    echo "Cloudflare refused the workers.dev name $subdomain: $(printf '%s' "$answer" | jq -c '.errors' 2>/dev/null)" >&2
    exit 1
  fi
fi

database() { npx wrangler d1 list --json | jq -r --arg name "$NAME" '.[] | select(.name == $name) | .uuid'; }
id="$(database)"
if [ -z "$id" ]; then
  npx wrangler d1 create "$NAME" > /dev/null
  id="$(database)"
fi
sed "s/00000000-0000-0000-0000-000000000000/$id/" wrangler.toml > deploy.wrangler.toml

npx wrangler d1 migrations apply "$NAME" --remote --config deploy.wrangler.toml
npx wrangler deploy --config deploy.wrangler.toml

url="https://$NAME.$subdomain.workers.dev"
printf '%s\n' "$url" > relay-url.txt
scripts/smoke.sh "$url"
