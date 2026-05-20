#!/usr/bin/env bash
# Export Azure resources from one or more resource groups into .healthmodel/raw/
# Usage: export-resources.sh <subscription-id> <rg1> [rg2 ...]
set -euo pipefail

SUB="${1:?subscription id required}"
shift
RGS=("$@")
[ "${#RGS[@]}" -gt 0 ] || { echo "at least one resource group required" >&2; exit 2; }

mkdir -p .healthmodel/raw

# Clear previous exports to avoid stale data from prior runs with different RG sets
rm -f .healthmodel/raw/*.json

for rg in "${RGS[@]}"; do
  az resource list -g "$rg" --subscription "$SUB" -o json > ".healthmodel/raw/$rg.json"
  echo "  exported: $rg ($(jq 'length' ".healthmodel/raw/$rg.json") resources)"
done

jq -s 'add' .healthmodel/raw/*.json > .healthmodel/raw/all.json
echo "merged → .healthmodel/raw/all.json"
