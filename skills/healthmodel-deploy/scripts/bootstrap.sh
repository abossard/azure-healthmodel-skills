#!/usr/bin/env bash
# Create the health model root resource (idempotent). Registers provider if needed.
# Usage: bootstrap.sh <rg> <model> <location> [uami-resource-id]
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "${SKILL_DIR}/scripts/lib/arm.sh"

RG="${1:?resource group required}"
MODEL="${2:?model name required}"
LOC="${3:?location required}"
UAMI="${4:-}"
SUB=$(arm_sub)

STATE=$(az provider show -n Microsoft.CloudHealth --query registrationState -o tsv 2>/dev/null || echo NotRegistered)
if [ "$STATE" != "Registered" ]; then
  echo "registering Microsoft.CloudHealth provider…"
  az provider register -n Microsoft.CloudHealth
  until [ "$(az provider show -n Microsoft.CloudHealth --query registrationState -o tsv)" = "Registered" ]; do sleep 5; done
fi

URL=$(arm_url "$SUB" "$RG" "$MODEL")
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT

if [ -n "$UAMI" ]; then
  cat > "$TMP" <<EOF
{
  "location": "$LOC",
  "identity": {
    "type": "SystemAssigned,UserAssigned",
    "userAssignedIdentities": { "$UAMI": {} }
  },
  "properties": {}
}
EOF
else
  cat > "$TMP" <<EOF
{ "location": "$LOC", "identity": { "type": "SystemAssigned" }, "properties": {} }
EOF
fi

arm_put "$URL" "$TMP" >/dev/null
echo "model: $MODEL ($LOC) → ready"
[ -n "$UAMI" ] && echo "  UAMI attached: $UAMI"
