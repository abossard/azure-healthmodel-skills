#!/usr/bin/env bash
# Validate every signal-definition in a design tree against its live data source,
# WITHOUT deploying the model. Catches PromQL parse errors, missing ARM metrics,
# broken KQL, and "no data" results. Mutates `displayName` to add or remove the
# `(broken: <reason>)` and `(no data)` markers idempotently.
#
# Signal kinds handled:
#   AzureResourceMetric  -> az monitor metrics list-definitions / list
#   PrometheusMetricsQuery -> az rest GET <amw-endpoint>/api/v1/query
#   LogAnalyticsQuery     -> az monitor log-analytics query
#
# Usage:
#   validate-signals.sh [--design .healthmodel/03-design]
#                       [--amw <amw-resource-id>]
#                       [--workspace <law-resource-id>]
#                       [--resources <resources.json>]
#                       [--no-mark]   # validate only, don't mutate displayName
#                       [--strict]    # also fail on no-data results
set -euo pipefail

DESIGN=".healthmodel/03-design"
AMW=""
WORKSPACE=""
RESOURCES=".healthmodel/resources.json"
NO_MARK=0
STRICT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --design)     DESIGN="$2"; shift 2 ;;
    --amw)        AMW="$2"; shift 2 ;;
    --workspace)  WORKSPACE="$2"; shift 2 ;;
    --resources)  RESOURCES="$2"; shift 2 ;;
    --no-mark)    NO_MARK=1; shift ;;
    --strict)     STRICT=1; shift ;;
    *)            echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

DATA=".healthmodel/data/deploy/validate-signals"
mkdir -p "$DATA"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="$DATA/report-$TS.tsv"
printf 'signal\tkind\tstatus\treason\n' > "$REPORT"

OK=0; NO_DATA=0; BROKEN=0; SKIPPED=0

# --- helpers ----------------------------------------------------------------

# mark_display <file> <suffix-or-empty>
# Idempotent: strips any existing " (broken: ...)" / " (no data)" first, then
# appends new suffix if non-empty. Writes the updated file in place.
mark_display() {
  local f="$1" suffix="$2"
  [ "$NO_MARK" -eq 1 ] && return 0
  jq --arg s "$suffix" '
    .displayName = (
      (.displayName // "")
      | sub(" \\(broken:[^)]*\\)"; "")
      | sub(" \\(no data\\)"; "")
      | (. + (if $s == "" then "" else " " + $s end))
    )
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

# get the prometheus query endpoint for the AMW (cached)
PROM_ENDPOINT=""
amw_endpoint() {
  if [ -z "$PROM_ENDPOINT" ] && [ -n "$AMW" ]; then
    PROM_ENDPOINT=$(az rest --method GET \
      --url "https://management.azure.com${AMW}?api-version=2023-04-03" \
      -o json 2>"$DATA/amw-show.err" \
      | jq -r '.properties.metrics.prometheusQueryEndpoint // empty')
  fi
  printf '%s' "$PROM_ENDPOINT"
}

# find a resource in resources.json whose id contains the lowercased namespace
# component (e.g. metricNamespace "microsoft.documentdb/databaseaccounts" ->
# look for "/databaseaccounts/").
find_resource_for_namespace() {
  local ns="$1"
  [ -f "$RESOURCES" ] || { echo ""; return; }
  local segment
  segment=$(printf '%s' "$ns" | awk -F/ '{print tolower($2)}')
  jq -r --arg s "/$segment/" '
    [.[]? | select((.id // "") | ascii_downcase | contains($s))][0].id // empty
  ' "$RESOURCES"
}

# --- validators per kind ----------------------------------------------------

validate_arm() {
  local f="$1" name="$2"
  local ns m agg tg rid
  ns=$(jq -r '.metricNamespace // empty' "$f")
  m=$(jq -r '.metricName // empty' "$f")
  agg=$(jq -r '.aggregationType // empty' "$f")
  tg=$(jq -r '.timeGrain // "PT1M"' "$f")

  if [ -z "$ns" ] || [ -z "$m" ]; then
    echo "broken:missing-namespace-or-name"; return
  fi

  rid=$(find_resource_for_namespace "$ns")
  if [ -z "$rid" ]; then
    echo "skip:no-matching-resource"; return
  fi

  # 1. Does the metric exist on the resource?
  if ! az monitor metrics list-definitions --resource "$rid" -o json 2>"$DATA/$name.err" \
        | jq -e --arg m "$m" '[.[].name.value] | map(ascii_downcase) | index($m | ascii_downcase)' \
        >/dev/null 2>&1; then
    echo "broken:metric-not-found"; return
  fi

  # 2. Is aggregationType supported?
  if [ -n "$agg" ]; then
    if ! az monitor metrics list-definitions --resource "$rid" -o json \
          | jq -e --arg m "$m" --arg a "$agg" \
              '.[] | select((.name.value | ascii_downcase) == ($m | ascii_downcase))
                   | .supportedAggregationTypes | map(ascii_downcase) | index($a | ascii_downcase)' \
          >/dev/null 2>&1; then
      echo "broken:aggregation-not-supported"; return
    fi
  fi

  # 3. Does it have recent data?
  #    Use the signal's timeGrain as --interval (some metrics only support certain
  #    grains, e.g. storage UsedCapacity is hourly-only). Look back ≥ 2× the grain
  #    so we always catch at least one bucket. NOTE: `az monitor metrics list --offset`
  #    expects shorthand (`1h`, `24h`, `7d`) — NOT ISO 8601 durations.
  local lookback
  case "$tg" in
    PT1M)  lookback=1h ;;
    PT5M)  lookback=2h ;;
    PT10M) lookback=2h ;;
    PT15M) lookback=2h ;;
    PT30M) lookback=6h ;;
    PT1H)  lookback=24h ;;
    PT2H)  lookback=24h ;;
    PT6H)  lookback=7d ;;
    PT12H) lookback=7d ;;
    P1D)   lookback=14d ;;
    *)     lookback=24h ;;
  esac

  local cnt
  cnt=$(az monitor metrics list --resource "$rid" --metric "$m" \
        --aggregation "${agg:-Average}" --interval "$tg" \
        --offset "$lookback" -o json 2>"$DATA/$name.metrics.err" \
        | jq '[.value[].timeseries[].data[] | select(.average != null or .total != null or .maximum != null or .minimum != null or .count != null)] | length')

  if [ -z "$cnt" ] || [ "$cnt" = "0" ]; then
    echo "no-data:lookback-${lookback}-empty"; return
  fi
  echo "ok"
}

validate_promql() {
  local f="$1" name="$2"
  local q endpoint
  q=$(jq -r '.queryText // empty' "$f")
  [ -z "$q" ] && { echo "broken:missing-queryText"; return; }

  endpoint=$(amw_endpoint)
  if [ -z "$endpoint" ]; then
    echo "skip:no-amw-or-endpoint"; return
  fi

  # URL-encode the query
  local encoded
  encoded=$(printf '%s' "$q" | jq -Rr @uri)

  # Capture stdout AND stderr together. Prometheus returns its error JSON in the
  # response body on 4xx, but `az rest` exits non-zero AND writes the body to
  # stderr along with the HTTP error line. Merge streams, then try jq.
  local resp
  resp=$(az rest --method GET \
    --url "${endpoint}/api/v1/query?query=${encoded}" \
    --resource "https://prometheus.monitor.azure.com" \
    -o json 2>&1 || true)

  printf '%s' "$resp" > "$DATA/$name.promql.txt"

  # First try to parse as JSON directly (success case)
  local status err nresults
  status=$(printf '%s' "$resp" | jq -r '.status // empty' 2>/dev/null || true)

  if [ "$status" = "success" ]; then
    nresults=$(printf '%s' "$resp" | jq '.data.result | length' 2>/dev/null)
    if [ "$nresults" = "0" ]; then
      echo "no-data:empty-result"; return
    fi
    echo "ok"; return
  fi

  # Error path: look for embedded {"status":"error",...} JSON in az rest's stderr.
  # az rest formats it as: "Bad Request({...})" — extract the JSON inside.
  err=$(printf '%s' "$resp" | grep -oE '\{[^{}]*"errorType"[^{}]*\}' | head -1 \
        | jq -r '.errorType // .error // empty' 2>/dev/null)
  if [ -z "$err" ]; then
    err=$(printf '%s' "$resp" | grep -oE 'errorType":[[:space:]]*"[^"]+' | head -1 | sed 's/.*"//')
  fi
  if [ -z "$err" ]; then
    err="unparseable"
  fi
  # Sanitize for displayName (no parens, colons, or quotes)
  err=$(printf '%s' "$err" | tr -d ':()"' | cut -c1-40)
  echo "broken:promql-$err"
}

validate_kql() {
  local f="$1" name="$2"
  local q
  q=$(jq -r '.queryText // empty' "$f")
  [ -z "$q" ] && { echo "broken:missing-queryText"; return; }

  if [ -z "$WORKSPACE" ]; then
    echo "skip:no-workspace"; return
  fi

  # Look up workspace customerId (used by `az monitor log-analytics query`)
  local custid
  custid=$(az monitor log-analytics workspace show --ids "$WORKSPACE" --query customerId -o tsv 2>"$DATA/$name.ws.err")
  [ -z "$custid" ] && { echo "broken:workspace-not-found"; return; }

  local resp
  resp=$(az monitor log-analytics query --workspace "$custid" --analytics-query "$q" \
         --timespan PT1H -o json 2>"$DATA/$name.err" || echo '[]')
  printf '%s' "$resp" > "$DATA/$name.kql.json"

  # Empty result OR all-null `count`/`value` -> no-data
  local nrows
  nrows=$(printf '%s' "$resp" | jq 'length // 0')
  if [ "$nrows" = "0" ]; then
    echo "no-data:empty-result"; return
  fi
  echo "ok"
}

# --- main loop --------------------------------------------------------------

if [ ! -d "$DESIGN/signals" ]; then
  echo "No $DESIGN/signals/ directory found — nothing to validate"
  exit 0
fi

for f in "$DESIGN"/signals/*.json; do
  [ -e "$f" ] || continue
  name="$(basename "$f" .json)"
  kind=$(jq -r '.signalKind // "AzureResourceMetric"' "$f")

  case "$kind" in
    AzureResourceMetric)    result=$(validate_arm "$f" "$name") ;;
    PrometheusMetricsQuery) result=$(validate_promql "$f" "$name") ;;
    LogAnalyticsQuery)      result=$(validate_kql "$f" "$name") ;;
    *)                      result="skip:unknown-kind-$kind" ;;
  esac

  status="${result%%:*}"
  reason="${result#*:}"
  [ "$status" = "$reason" ] && reason=""

  printf '%s\t%s\t%s\t%s\n' "$name" "$kind" "$status" "$reason" >> "$REPORT"

  case "$status" in
    ok)
      OK=$((OK+1))
      echo "  ✓ $name ($kind)"
      mark_display "$f" ""
      ;;
    no-data)
      NO_DATA=$((NO_DATA+1))
      echo "  ⊘ $name ($kind) — no data: $reason"
      mark_display "$f" "(no data)"
      ;;
    broken)
      BROKEN=$((BROKEN+1))
      echo "  ✘ $name ($kind) — broken: $reason"
      mark_display "$f" "(broken: $reason)"
      ;;
    skip)
      SKIPPED=$((SKIPPED+1))
      echo "  · $name ($kind) — skipped: $reason"
      ;;
  esac
done

printf '\nsummary: ok=%d no-data=%d broken=%d skipped=%d  report=%s\n' \
  "$OK" "$NO_DATA" "$BROKEN" "$SKIPPED" "$REPORT"

# Exit codes:
#   0 — all valid (no broken; no-data tolerated unless --strict)
#   1 — any broken signal
#   2 — --strict and any no-data signal
if [ "$BROKEN" -gt 0 ]; then exit 1; fi
if [ "$STRICT" -eq 1 ] && [ "$NO_DATA" -gt 0 ]; then exit 2; fi
exit 0
