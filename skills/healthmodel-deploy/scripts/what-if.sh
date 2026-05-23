#!/usr/bin/env bash
# Preview changes using az deployment group what-if.
# Usage: what-if.sh <rg> [bicep-dir]
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "${SKILL_DIR}/scripts/lib/arm.sh"

RG="${1:?resource group required}"
BICEP_DIR="${2:-.healthmodel/05-bicep}"
MAIN="${BICEP_DIR}/main.bicep"

[ -f "$MAIN" ] || { echo "Bicep project not found: $MAIN — regenerate from design" >&2; exit 2; }

echo "== what-if preview =="
echo "  resource group: $RG"
echo "  bicep: $MAIN"
echo ""

# Read parameters from discovery
MODEL_NAME=$(jq -r '.appName // "healthmodel"' .healthmodel/01-discovery.json 2>/dev/null)
MODEL_NAME="hm-${MODEL_NAME}"
LOCATION=$(jq -r '.location // "swedencentral"' .healthmodel/01-discovery.json 2>/dev/null)

az deployment group what-if \
  --resource-group "$RG" \
  --template-file "$MAIN" \
  --parameters healthModelName="$MODEL_NAME" location="$LOCATION" \
  --no-pretty-print 2>&1 | tee .healthmodel/04-what-if.txt

echo ""
echo "what-if output → .healthmodel/04-what-if.txt"
