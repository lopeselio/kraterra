#!/usr/bin/env bash
# One-time: an Azure Files share mounted at /data in the container app, so match records and
# proof bundles survive restarts and redeploys. Idempotent.
set -euo pipefail
RG=${RG:-kraterra}
APP=${APP:-kraterra}
ENV_NAME=${ENV_NAME:-kraterra-env}
SHARE=${SHARE:-kraterradata}
cd "$(dirname "$0")/.."

SA=${SA:-$(az storage account list -g "$RG" --query '[0].name' -o tsv)}
if [ -z "$SA" ]; then
  SA="kraterra$(openssl rand -hex 3)"
  az storage account create -g "$RG" -n "$SA" --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false -o none
fi
KEY=$(az storage account keys list -g "$RG" -n "$SA" --query '[0].value' -o tsv)
az storage share-rm show -g "$RG" --storage-account "$SA" -n "$SHARE" -o none 2>/dev/null || az storage share-rm create -g "$RG" --storage-account "$SA" -n "$SHARE" --quota 5 -o none
az containerapp env storage set -g "$RG" -n "$ENV_NAME" --storage-name data --azure-file-account-name "$SA" --azure-file-account-key "$KEY" --azure-file-share-name "$SHARE" --access-mode ReadWrite -o none

# add the volume and mount to the app's template (the CLI has no flag for it; JSON is valid YAML for --yaml)
TMP=$(mktemp)
az containerapp show -g "$RG" -n "$APP" -o json > "$TMP"
python3 - "$TMP" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
t = d['properties']['template']
t['volumes'] = [{'name': 'data', 'storageType': 'AzureFile', 'storageName': 'data', 'mountOptions': 'uid=1000,gid=1000,dir_mode=0770,file_mode=0660'}]
for c in t['containers']:
    c['volumeMounts'] = [{'volumeName': 'data', 'mountPath': '/data'}]
    env = [e for e in c.get('env', []) if e['name'] != 'DATA_DIR']
    env.append({'name': 'DATA_DIR', 'value': '/data'})
    c['env'] = env
# secrets come back without values; the update keeps the existing ones when they're left out
d['properties']['configuration'].pop('secrets', None)
json.dump(d, open(p, 'w'))
PY
az containerapp update -g "$RG" -n "$APP" --yaml "$TMP" -o none
rm -f "$TMP"
echo "mounted share $SHARE ($SA) at /data"
