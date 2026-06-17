#!/usr/bin/env bash
# Ensure the az monitor health-models extension is installed and the CloudHealth
# provider is registered. Idempotent.
# Usage: bootstrap.sh
set -euo pipefail

DATA=".healthmodel/data/deploy/bootstrap"
mkdir -p "$DATA"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# 1. Extension
if ! az extension show --name health-models >/dev/null 2>&1; then
  echo "Installing az monitor health-models extension..."
  az extension add --name health-models --yes >"$DATA/extension-add-$TS.log" 2>&1 \
    || { echo "Failed to install extension. See $DATA/extension-add-$TS.log"; exit 1; }
fi
az extension show --name health-models -o json >"$DATA/extension-$TS.json"

EXT_VERSION=$(jq -r '.version // "unknown"' "$DATA/extension-$TS.json")
echo "✓ az monitor health-models extension installed (version: $EXT_VERSION)"

# 2. Resource provider
SUB=$(az account show --query id -o tsv)
STATE=$(az provider show -n Microsoft.CloudHealth --query registrationState -o tsv 2>/dev/null || echo NotRegistered)
if [ "$STATE" != "Registered" ]; then
  echo "Registering Microsoft.CloudHealth (state: $STATE)..."
  az provider register -n Microsoft.CloudHealth --wait >"$DATA/provider-register-$TS.log" 2>&1
  STATE=$(az provider show -n Microsoft.CloudHealth --query registrationState -o tsv)
fi
echo "✓ Microsoft.CloudHealth: $STATE (subscription: $SUB)"

# 3. Sanity check: command surface
az monitor health-models --help >"$DATA/help-$TS.txt" 2>&1
echo "✓ az monitor health-models is callable"
