#!/usr/bin/env bash
# Probe relationship anchors (AKS, Cosmos, ingress, AMW) + RBAC scope
# Usage: relationships.sh <subscription-id>
set -euo pipefail

SUB="${1:?subscription id required}"
IN=".healthmodel/resources.json"
test -f "$IN" || { echo "$IN missing — run inventory.sh first" >&2; exit 2; }

echo "== AKS =="
jq '[.[] | select(.type=="Microsoft.ContainerService/managedClusters") | {name, rg, id}]' "$IN"

echo "== Cosmos =="
jq '[.[] | select(.type | startswith("Microsoft.DocumentDB")) | {name, rg, id}]' "$IN"

echo "== Ingress (Front Door / CDN) =="
jq '[.[] | select(.type | test("Microsoft.Cdn|Microsoft.Network/frontDoors")) | {name, rg, id}]' "$IN"

echo "== Azure Monitor Workspace =="
jq '[.[] | select(.type=="Microsoft.Monitor/accounts") | {name, rg, id}]' "$IN"

echo "== RBAC → .healthmodel/raw/rbac.json =="
# Limit RBAC export to monitored RGs only (avoids leaking unrelated subscription assignments)
RGS=$(jq -r '.[] | .rg // empty' "$IN" | sort -u)
RBAC_FILTER='[]'
for rg in $RGS; do
  assignments=$(az role assignment list --resource-group "$rg" --subscription "$SUB" -o json 2>/dev/null \
    | jq '[.[] | {principalId, scope, role: .roleDefinitionName}]')
  RBAC_FILTER=$(printf '%s\n%s' "$RBAC_FILTER" "$assignments" | jq -s 'add')
done
printf '%s' "$RBAC_FILTER" > .healthmodel/raw/rbac.json
echo "  $(jq 'length' .healthmodel/raw/rbac.json) assignments"
