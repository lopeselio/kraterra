#!/usr/bin/env bash
# Build the image in Azure Container Registry and run it on Azure Container Apps.
#   scripts/deploy-azure.sh            # first run creates the resource group, registry, identity, environment
#   SKIP_SETUP=1 scripts/deploy-azure.sh   # later runs: build + roll out only
# Secrets come from .env (NEARAI_*, SESSION_SECRET) and ~/.near-credentials (referee, relayer and Basalt keys).
# One replica only: Basalt's timers, the chain queue and websockets live in memory, so every player must reach the same instance.
set -euo pipefail
RG=${RG:-kraterra}
LOC=${LOC:-northeurope}
APP=${APP:-kraterra}
ENV_NAME=${ENV_NAME:-kraterra-env}
IDENTITY=${IDENTITY:-kraterra-pull}
cd "$(dirname "$0")/.."
TAG=${TAG:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M%S)}
set -a; [ -f .env ] && . ./.env; set +a
CONTRACT=${CONTRACT_ID:-kraterra.testnet}
REFEREE=${REFEREE_ID:-kraterra-ref.testnet}
RELAYER=${RELAYER_ID:-kraterra-relay.testnet}

az extension add -n containerapp --upgrade -y -o none 2>/dev/null || true
if [ -z "${SKIP_SETUP:-}" ]; then
  for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry; do az provider register -n "$ns" --wait -o none; done
  az group create -n "$RG" -l "$LOC" -o none
fi
ACR=${ACR:-$(az acr list -g "$RG" --query '[0].name' -o tsv)}
if [ -z "$ACR" ]; then ACR="kraterra$(openssl rand -hex 3)"; az acr create -g "$RG" -n "$ACR" --sku Basic -o none; fi
az identity show -g "$RG" -n "$IDENTITY" -o none 2>/dev/null || az identity create -g "$RG" -n "$IDENTITY" -o none
ID_RES=$(az identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)
ID_PRINCIPAL=$(az identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)
ACR_ID=$(az acr show -g "$RG" -n "$ACR" --query id -o tsv)
if [ -z "$(az role assignment list --assignee "$ID_PRINCIPAL" --scope "$ACR_ID" --role AcrPull --query '[0].id' -o tsv)" ]; then
  az role assignment create --assignee-object-id "$ID_PRINCIPAL" --assignee-principal-type ServicePrincipal --role AcrPull --scope "$ACR_ID" -o none
  echo "waiting for the AcrPull role to propagate…"; sleep 60
fi

az acr build -r "$ACR" -t "kraterra:$TAG" --build-arg "APP_VERSION=$TAG" . -o none
IMAGE="$ACR.azurecr.io/kraterra:$TAG"

# the referee's, relayer's and agents' keys, as one JSON secret
KEYS=$(node -e '
  const fs = require("fs"), os = require("os"), path = require("path");
  const [contract, referee, relayer] = process.argv.slice(1);
  // the referee, the relayer, and Basalt the AI tank (a function-call key only)
  const ids = [referee, relayer, `basalt.${contract}`];
  const out = {};
  for (const id of ids) out[id] = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".near-credentials", "testnet", `${id}.json`), "utf8")).private_key;
  process.stdout.write(JSON.stringify(out));' "$CONTRACT" "$REFEREE" "$RELAYER")

# the public URL players use: the wallet signs "Sign in to <host>" for it (Better Auth)
FQDN_NOW=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv 2>/dev/null || true)
# a bound custom domain (e.g. <game>.lopeselio.online) wins over the default Azure hostname
CUSTOM_NOW=$(az containerapp hostname list -g "$RG" -n "$APP" --query "[0].name" -o tsv 2>/dev/null || true)
PUBLIC_URL=${PUBLIC_URL:-${CUSTOM_NOW:+https://$CUSTOM_NOW}}
PUBLIC_URL=${PUBLIC_URL:-${FQDN_NOW:+https://$FQDN_NOW}}

az containerapp env show -g "$RG" -n "$ENV_NAME" -o none 2>/dev/null || az containerapp env create -g "$RG" -n "$ENV_NAME" -l "$LOC" -o none
ENVS=(NEAR_NETWORK=testnet DATA_DIR=/data "CONTRACT_ID=$CONTRACT" "REFEREE_ID=$REFEREE" "RELAYER_ID=$RELAYER" ${PUBLIC_URL:+"BETTER_AUTH_URL=$PUBLIC_URL"} "NEARAI_BASE_URL=${NEARAI_BASE_URL:-https://cloud-api.near.ai/v1}" "NEARAI_MODEL=${NEARAI_MODEL:-Qwen/Qwen3.6-35B-A3B-FP8}" NEAR_KEYS=secretref:near-keys NEARAI_API_KEY=secretref:nearai-key SESSION_SECRET=secretref:session-secret)
if az containerapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  az containerapp secret set -g "$RG" -n "$APP" --secrets "near-keys=$KEYS" "nearai-key=${NEARAI_API_KEY:-none}" "session-secret=${SESSION_SECRET:?set SESSION_SECRET in .env}" -o none
  az containerapp update -g "$RG" -n "$APP" --image "$IMAGE" --set-env-vars "${ENVS[@]}" -o none
else
  az containerapp create -g "$RG" -n "$APP" --environment "$ENV_NAME" --image "$IMAGE" \
    --user-assigned "$ID_RES" --registry-server "$ACR.azurecr.io" --registry-identity "$ID_RES" \
    --target-port 8080 --ingress external --min-replicas 1 --max-replicas 1 --cpu 0.5 --memory 1.0Gi \
    --secrets "near-keys=$KEYS" "nearai-key=${NEARAI_API_KEY:-none}" "session-secret=${SESSION_SECRET:?set SESSION_SECRET in .env}" \
    --env-vars "${ENVS[@]}" -o none
fi
FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
echo "https://$FQDN/"
for _ in $(seq 1 30); do
  if curl -fsS "https://$FQDN/api/health" 2>/dev/null | grep -q "\"$TAG\""; then echo "live: $TAG"; exit 0; fi
  sleep 10
done
echo "the new revision didn't report $TAG within 5 minutes" >&2; exit 1
