#!/usr/bin/env bash
# Fast-path entity discovery: create a discovery-rule from a Resource Graph query
# and wait for entities to populate. Bypasses the full design pipeline.
# Usage: discover-auto.sh <rg> <model> <rule-name> <auth-name> \
#                         "<resource-graph-query>" [--timeout 600] [--interval 30]
set -euo pipefail

RG="${1:?resource group required}"
MODEL="${2:?model name required}"
RULE="${3:?rule name required}"
AUTH="${4:?auth setting name required}"
QUERY="${5:?resource-graph query required}"
shift 5

TIMEOUT=600; INTERVAL=30
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout)  TIMEOUT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *)          echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

DATA=".healthmodel/data/deploy/discover-auto"
mkdir -p "$DATA"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# 1. baseline: count existing entities (so we can detect new ones)
az monitor health-models entity list -g "$RG" --health-model-name "$MODEL" \
  -o json > "$DATA/entities-before-$TS.json"
BEFORE=$(jq 'length' "$DATA/entities-before-$TS.json")
echo "Entities before: $BEFORE"

# 2. write specification and create the discovery rule
SPEC="$DATA/spec-$RULE.json"
jq -n --arg q "$QUERY" '{resourceGraphQuery: {resourceGraphQuery: $q}}' > "$SPEC"

echo "Creating discovery-rule $RULE..."
az monitor health-models discovery-rule create \
  -g "$RG" --health-model-name "$MODEL" -n "$RULE" \
  --authentication-setting "$AUTH" \
  --add-recommended-signals Enabled \
  --discover-relationships Enabled \
  --specification "@$SPEC" \
  -o json > "$DATA/discovery-rule-$RULE-$TS.json"
echo "✓ rule created"

# 3. poll for entities to appear
echo "Waiting up to ${TIMEOUT}s for entities to populate..."
ELAPSED=0
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  az monitor health-models entity list -g "$RG" --health-model-name "$MODEL" \
    -o json > "$DATA/entities-after-$TS.json"
  AFTER=$(jq 'length' "$DATA/entities-after-$TS.json")
  NEW=$((AFTER - BEFORE))
  if [ "$NEW" -gt 0 ]; then
    echo "✓ $NEW new entity/entities discovered (total now: $AFTER)"
    jq -r '.[].name' "$DATA/entities-after-$TS.json" | sort | head
    exit 0
  fi
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
  echo "  ⏳ no new entities yet (${ELAPSED}/${TIMEOUT}s)"
done

echo "✘ timeout: no entities materialised after ${TIMEOUT}s"
echo "  Check that the Resource Graph query returns rows containing an 'id' column."
exit 1
