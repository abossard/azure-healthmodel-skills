#!/usr/bin/env bash
# Bootstrap: register provider and verify RBAC. Model root creation is handled by Bicep.
# Usage: bootstrap.sh <rg> <model> <location> [uami-resource-id]
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "${SKILL_DIR}/scripts/lib/arm.sh"

RG="${1:?resource group required}"
MODEL="${2:?model name required}"
LOC="${3:?location required}"
UAMI="${4:-}"
SUB=$(arm_sub)

# Step 1: Register Microsoft.CloudHealth provider
STATE=$(az provider show -n Microsoft.CloudHealth --query registrationState -o tsv 2>/dev/null || echo NotRegistered)
if [ "$STATE" != "Registered" ]; then
  echo "registering Microsoft.CloudHealth provider…"
  az provider register -n Microsoft.CloudHealth
  until [ "$(az provider show -n Microsoft.CloudHealth --query registrationState -o tsv)" = "Registered" ]; do sleep 5; done
fi
echo "✓ Microsoft.CloudHealth provider registered"

# Step 2: Verify resource group exists
az group show --name "$RG" -o none 2>/dev/null \
  || { echo "✘ resource group '$RG' not found"; exit 1; }
echo "✓ resource group '$RG' exists"

# Step 3: Verify UAMI and RBAC (if provided)
if [ -n "$UAMI" ]; then
  if ! az identity show --ids "$UAMI" -o none 2>&1; then
    echo "⚠ UAMI not found or inaccessible: $UAMI"
    echo "  Create it first:  az identity create -g <rg> -n <name>"
    echo "  Or verify the resource ID is correct (full ARM path required)"
    exit 1
  fi
  echo "✓ UAMI exists: $UAMI"

  # Verify/assign Monitoring Reader on the target RG
  PRINCIPAL=$(az identity show --ids "$UAMI" --query principalId -o tsv 2>/dev/null)
  if [ -n "$PRINCIPAL" ]; then
    EXISTING=$(az role assignment list --assignee "$PRINCIPAL" --role "Monitoring Reader" \
      --scope "/subscriptions/$SUB/resourceGroups/$RG" -o json 2>/dev/null | jq 'length')
    if [ "${EXISTING:-0}" = "0" ]; then
      az role assignment create --assignee "$PRINCIPAL" --role "Monitoring Reader" \
        --scope "/subscriptions/$SUB/resourceGroups/$RG" -o none 2>/dev/null \
        && echo "  ✓ assigned Monitoring Reader to $PRINCIPAL on $RG" \
        || echo "  ⚠ failed to assign Monitoring Reader — assign manually"
    else
      echo "  ✓ Monitoring Reader already assigned on $RG"
    fi
  else
    echo "  ⚠ could not resolve UAMI principalId — verify RBAC manually"
  fi
fi

echo ""
echo "bootstrap complete — ready for Bicep deployment"
echo "  model: $MODEL ($LOC)"
echo "  Note: model root resource will be created by Bicep during deployment"
