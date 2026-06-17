#!/usr/bin/env bash
# Read signal health for every entity in a health model using the extension's
# read primitives. Per criterion: uses `entity show` per entity (one call each)
# to project signalGroups[].signals[].status — and optionally `entity get-signal-history`
# for time-series detail when --with-history is set.
#
# Uses the extension's read primitives only — no raw ARM URLs, no curl.
#
# Usage: smoke.sh <rg> <model> [--wait] [--timeout 600] [--interval 30] [--with-history]
set -euo pipefail

RG="${1:?resource group required}"
MODEL="${2:?model name required}"
shift 2

WAIT=0; TIMEOUT=600; INTERVAL=30; HISTORY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --wait)         WAIT=1; shift ;;
    --timeout)      TIMEOUT="$2"; shift 2 ;;
    --interval)     INTERVAL="$2"; shift 2 ;;
    --with-history) HISTORY=1; shift ;;
    *)              echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

DATA=".healthmodel/data/deploy/smoke"
mkdir -p "$DATA"

run_smoke() {
  local TS="$1"
  local REPORT="$DATA/smoke-$TS.txt"
  : > "$REPORT"

  # 1) Enumerate entities via `entity list`
  local NAMES_FILE="$DATA/entity-names-$TS.tsv"
  az monitor health-models entity list -g "$RG" --health-model-name "$MODEL" \
    --query '[].name' -o tsv > "$NAMES_FILE"

  local total=0 unknown=0 healthy=0 degraded=0 unhealthy=0 nosignals=0

  # 2) For each entity, call `entity show` (one call) — projects signal status
  while IFS= read -r ename; do
    [ -z "$ename" ] && continue
    local SHOW_FILE="$DATA/entity-$ename.json"
    az monitor health-models entity show -g "$RG" --health-model-name "$MODEL" \
      -n "$ename" -o json > "$SHOW_FILE" 2>"$DATA/entity-$ename.err" || {
        echo "  ! $ename — show failed (see $DATA/entity-$ename.err)" | tee -a "$REPORT"
        continue
      }

    # 3) Walk signalGroups.*.signals[]
    local sig_count
    sig_count=$(jq '[.properties.signalGroups // {} | to_entries[]?.value.signals // [] | .[]?] | length' "$SHOW_FILE")
    if [ "$sig_count" = "0" ] || [ -z "$sig_count" ]; then
      nosignals=$((nosignals+1))
      continue
    fi

    while IFS=$'\t' read -r sname state value; do
      [ -z "$sname" ] && continue
      total=$((total+1))
      local mark
      case "$state" in
        Healthy)   healthy=$((healthy+1));   mark="✓" ;;
        Degraded)  degraded=$((degraded+1)); mark="~" ;;
        Unhealthy) unhealthy=$((unhealthy+1)); mark="✘" ;;
        *)         unknown=$((unknown+1));   mark="?" ;;
      esac
      printf '  %s %s/%s (%s, value=%s)\n' "$mark" "$ename" "$sname" "$state" "$value" \
        | tee -a "$REPORT"

      # 4) Optional time-series via get-signal-history
      if [ "$HISTORY" -eq 1 ]; then
        local HFILE="$DATA/history-$ename-$sname-$TS.json"
        az monitor health-models entity get-signal-history \
          -g "$RG" --health-model-name "$MODEL" \
          --entity-name "$ename" --signal-name "$sname" \
          -o json > "$HFILE" 2>"$HFILE.err" || {
            echo "      ! get-signal-history failed for $ename/$sname" | tee -a "$REPORT"
            continue
          }
        local hcount
        hcount=$(jq '.history | length' "$HFILE")
        printf '      history: %s point(s) — %s\n' "$hcount" "$HFILE" | tee -a "$REPORT"
      fi
    done < <(jq -r '
      .properties.signalGroups // {}
      | to_entries[]?.value.signals // []
      | .[]?
      | [.name, (.status.healthState // "Unknown"),
         (.status.value // "n/a" | tostring)]
      | @tsv
    ' "$SHOW_FILE")
  done < "$NAMES_FILE"

  printf '\nsummary: total=%d healthy=%d degraded=%d unhealthy=%d unknown=%d entities-without-signals=%d\n' \
    "$total" "$healthy" "$degraded" "$unhealthy" "$unknown" "$nosignals" | tee -a "$REPORT"
  echo "report → $REPORT"

  if [ "$unhealthy" -gt 0 ]; then return 1
  elif [ "$unknown" -gt 0 ] && [ "$total" -gt 0 ]; then return 2
  else return 0
  fi
}

if [ "$WAIT" -eq 0 ]; then
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  run_smoke "$TS"
  exit $?
fi

echo "== smoke with retry (timeout=${TIMEOUT}s, interval=${INTERVAL}s) =="
ELAPSED=0
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  TS="$(date -u +%Y%m%dT%H%M%SZ)"
  set +e; run_smoke "$TS"; RC=$?; set -e
  case "$RC" in
    0) echo "✓ all signals healthy"; exit 0 ;;
    1) echo "✘ unhealthy signals detected"; exit 1 ;;
    2)
      ELAPSED=$((ELAPSED + INTERVAL))
      if [ "$ELAPSED" -lt "$TIMEOUT" ]; then
        echo "  ⏳ unknown signals — retrying in ${INTERVAL}s (${ELAPSED}/${TIMEOUT}s)"
        sleep "$INTERVAL"
      fi ;;
  esac
done

echo "✘ timeout: signals still Unknown after ${TIMEOUT}s — check RBAC or signal config"
exit 1
