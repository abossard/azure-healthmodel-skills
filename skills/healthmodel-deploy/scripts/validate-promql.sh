#!/usr/bin/env bash
# ============================================================================
# Validate PromQL signal definitions against a live Azure Monitor Workspace
# ============================================================================
# Usage:
#   validate-promql.sh <AMW_RESOURCE_ID> [design-dir]
#
# Walks all signal definition files, finds PrometheusMetricsQuery signals,
# and tests each queryText against the live AMW. Marks failing signals with
# "(broken)" in displayName.
#
# Exit code:
#   0 — all PromQL signals validated (or none found)
#   1 — at least one signal failed validation

set -euo pipefail

AMW_ID="${1:?Usage: validate-promql.sh <AMW_RESOURCE_ID> [design-dir]}"
DESIGN_DIR="${2:-.healthmodel/03-design}"
SIGNALS_DIR="${DESIGN_DIR}/signals"

DATA=".healthmodel/data/signals/validation"
mkdir -p "$DATA"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [ ! -d "$SIGNALS_DIR" ]; then
  echo "⚠  No signals directory at $SIGNALS_DIR — nothing to validate"
  exit 0
fi

# --- Resolve the Prometheus query endpoint -----------------------------------

echo "📡 Resolving Prometheus endpoint for AMW..."
AMW_RESPONSE=$(az rest --method GET \
  --url "https://management.azure.com${AMW_ID}?api-version=2023-04-03" \
  -o json 2>&1)
echo "$AMW_RESPONSE" > "$DATA/amw-endpoint-$TIMESTAMP.json"
echo "  AMW response → $DATA/amw-endpoint-$TIMESTAMP.json"

ENDPOINT=$(echo "$AMW_RESPONSE" | jq -r '.properties.metrics.prometheusQueryEndpoint // empty')

if [ -z "$ENDPOINT" ]; then
  echo "❌ No prometheusQueryEndpoint found on workspace:"
  echo "   $AMW_ID"
  echo "   Ensure managed Prometheus is enabled on the AKS cluster."
  exit 1
fi

echo "   $ENDPOINT"
echo ""

# --- Walk signal files -------------------------------------------------------

PASS=0
FAIL=0
SKIP=0
TOTAL=0

for f in "$SIGNALS_DIR"/*.json; do
  [ -f "$f" ] || continue

  KIND=$(jq -r '.signalKind // ""' "$f")
  [ "$KIND" = "PrometheusMetricsQuery" ] || continue

  TOTAL=$((TOTAL + 1))
  NAME=$(basename "$f" .json)
  DISPLAY=$(jq -r '.displayName // ""' "$f")
  QUERY=$(jq -r '.queryText // ""' "$f")

  if [ -z "$QUERY" ]; then
    echo "⏭  $NAME: no queryText — skipping"
    SKIP=$((SKIP + 1))
    continue
  fi

  # URL-encode the query using jq (no python)
  ENCODED=$(printf '%s' "$QUERY" | jq -Rr @uri)

  # Execute the query against the AMW
  RESULT=$(az rest --method GET \
    --url "${ENDPOINT}/api/v1/query?query=${ENCODED}" \
    --resource "https://prometheus.monitor.azure.com" \
    -o json 2>&1) || {
    echo "❌ $NAME: az rest failed"
    echo "   Query: $QUERY"
    echo "   Error: $RESULT"
    echo "$RESULT" > "$DATA/$NAME-$TIMESTAMP.json"
    echo "   → $DATA/$NAME-$TIMESTAMP.json"

    # Mark as broken
    if [[ "$DISPLAY" != *"(broken)"* ]]; then
      jq --arg d "${DISPLAY} (broken)" '.displayName = $d' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      echo "   ⚠️  Marked displayName as '${DISPLAY} (broken)'"
    fi

    FAIL=$((FAIL + 1))
    continue
  }

  STATUS=$(echo "$RESULT" | jq -r '.status // "error"')
  echo "$RESULT" > "$DATA/$NAME-$TIMESTAMP.json"

  if [ "$STATUS" = "success" ]; then
    COUNT=$(echo "$RESULT" | jq '.data.result | length')
    VALUE=$(echo "$RESULT" | jq -r 'if .data.result | length > 0 then .data.result[0].value[1] else "no series" end')
    echo "✅ $NAME: status=success results=$COUNT value=$VALUE"

    # Remove (broken) marker if it was previously set
    if [[ "$DISPLAY" == *"(broken)"* ]]; then
      CLEAN=$(echo "$DISPLAY" | sed 's/ *(broken)$//')
      jq --arg d "$CLEAN" '.displayName = $d' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      echo "   ✨ Removed (broken) marker — signal now validates"
    fi

    PASS=$((PASS + 1))
  else
    ERROR_TYPE=$(echo "$RESULT" | jq -r '.errorType // "unknown"')
    ERROR_MSG=$(echo "$RESULT" | jq -r '.error // "unknown error"')
    echo "❌ $NAME: $ERROR_TYPE — $ERROR_MSG"
    echo "   Query: $QUERY"

    # Mark as broken
    if [[ "$DISPLAY" != *"(broken)"* ]]; then
      jq --arg d "${DISPLAY} (broken)" '.displayName = $d' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
      echo "   ⚠️  Marked displayName as '${DISPLAY} (broken)'"
    fi

    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
SUMMARY="  PromQL validation: ✅ $PASS passed, ❌ $FAIL failed, ⏭ $SKIP skipped ($TOTAL total)"
echo "$SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$TOTAL" -eq 0 ]; then
  echo "  No PrometheusMetricsQuery signals found in $SIGNALS_DIR"
fi

# Persist summary
{
  echo "timestamp: $TIMESTAMP"
  echo "amw: $AMW_ID"
  echo "$SUMMARY"
  echo "signals_dir: $SIGNALS_DIR"
} > "$DATA/summary-$TIMESTAMP.txt"
echo "  report → $DATA/summary-$TIMESTAMP.txt"

[ "$FAIL" -eq 0 ]
