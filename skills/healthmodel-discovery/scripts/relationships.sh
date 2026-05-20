#!/usr/bin/env bash
# Probe relationship anchors and collect data into .healthmodel/data/
# Usage: relationships.sh <subscription-id>
#
# Output hierarchy:
#   .healthmodel/data/relationships/
#   ├── anchors-by-type.json
#   ├── diagnostic-settings/
#   │   └── <resource-name>.json   (per-resource diagnostic settings)
#   └── rbac/
#       ├── <rg-name>.json         (per-RG role assignments)
#       └── all-assignments.json   (merged)
set -euo pipefail

SUB="${1:?subscription id required}"
IN=".healthmodel/resources.json"
test -f "$IN" || { echo "$IN missing — run inventory.sh first" >&2; exit 2; }

DATA=".healthmodel/data/relationships"
DIAG_DIR="$DATA/diagnostic-settings"
RBAC_DIR="$DATA/rbac"
mkdir -p "$DIAG_DIR" "$RBAC_DIR"

echo "== Resource anchors by type =="
# Group all resources by type and save each group
jq 'group_by(.type) | map({type: .[0].type, resources: map({name, rg, id, kind})})' "$IN" \
  > "$DATA/anchors-by-type.json"
echo "  → $DATA/anchors-by-type.json"
jq -r '.[] | "\(.resources | length)\t\(.type)"' "$DATA/anchors-by-type.json"

echo
echo "== Diagnostic Settings Coverage =="
jq -r '.[].id' "$IN" | while read -r rid; do
  NAME="$(echo "$rid" | rev | cut -d/ -f1 | rev)"
  RESULT=$(az monitor diagnostic-settings list --resource "$rid" -o json 2>&1 || true)
  echo "$RESULT" > "$DIAG_DIR/$NAME.json"
  SETTINGS=$(echo "$RESULT" | jq '(.value // .)' 2>/dev/null || echo "[]")
  COUNT=$(echo "$SETTINGS" | jq 'length')
  if [ "$COUNT" = "0" ] || [ "$COUNT" = "" ]; then
    echo "  ⚠ NO diagnostics: $NAME → $DIAG_DIR/$NAME.json"
  else
    echo "  ✓ $NAME ($COUNT settings) → $DIAG_DIR/$NAME.json"
  fi
done

echo
echo "== RBAC =="
RGS=$(jq -r '.[] | .rg // empty' "$IN" | sort -u)
RBAC_FILTER='[]'
for rg in $RGS; do
  RESULT=$(az role assignment list --resource-group "$rg" --subscription "$SUB" -o json 2>&1 || true)
  echo "$RESULT" > "$RBAC_DIR/$rg.json"
  assignments=$(echo "$RESULT" | jq '[.[] | {principalId, scope, role: .roleDefinitionName}]' 2>/dev/null || echo '[]')
  RBAC_FILTER=$(printf '%s\n%s' "$RBAC_FILTER" "$assignments" | jq -s 'add')
  echo "  $rg → $RBAC_DIR/$rg.json"
done
printf '%s' "$RBAC_FILTER" > "$RBAC_DIR/all-assignments.json"
echo "  merged: $(jq 'length' "$RBAC_DIR/all-assignments.json") assignments → $RBAC_DIR/all-assignments.json"
