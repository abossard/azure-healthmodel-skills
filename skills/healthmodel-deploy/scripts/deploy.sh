#!/usr/bin/env bash
# Deploy the health model using az deployment group create.
# Usage: deploy.sh <rg> [bicep-dir] [--yes]
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "${SKILL_DIR}/scripts/lib/arm.sh"

RG="${1:?resource group required}"
shift
BICEP_DIR=".healthmodel/05-bicep"
YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    *) BICEP_DIR="$1"; shift ;;
  esac
done

MAIN="${BICEP_DIR}/main.bicep"
[ -f "$MAIN" ] || { echo "Bicep project not found: $MAIN — regenerate from design" >&2; exit 2; }

# Read parameters from discovery
MODEL_NAME=$(jq -r '.appName // "healthmodel"' .healthmodel/01-discovery.json 2>/dev/null)
MODEL_NAME="hm-${MODEL_NAME}"
LOCATION=$(jq -r '.location // "swedencentral"' .healthmodel/01-discovery.json 2>/dev/null)

echo "== deploying health model =="
echo "  resource group: $RG"
echo "  model: $MODEL_NAME"
echo "  location: $LOCATION"
echo "  bicep: $MAIN"
echo ""

if [ "$YES" -ne 1 ]; then
  printf "proceed with deployment? [y/N] " >&2; read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "aborted"; exit 1; }
fi

az deployment group create \
  --resource-group "$RG" \
  --template-file "$MAIN" \
  --parameters healthModelName="$MODEL_NAME" location="$LOCATION" \
  --name "healthmodel-$(date -u +%Y%m%d%H%M%S)" \
  -o json | jq '{name: .name, state: .properties.provisioningState, duration: .properties.duration}'

echo ""
echo "deployment complete"

# Write receipt
SUB=$(arm_sub)
cat > .healthmodel/04-deployed.json <<EOF
{
  "modelName": "$MODEL_NAME",
  "resourceGroup": "$RG",
  "subscription": "$SUB",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "deploymentMethod": "bicep",
  "bicepProject": "$MAIN"
}
EOF
echo "receipt → .healthmodel/04-deployed.json"
