#!/usr/bin/env bash
# Check signal health for every entity with retry/backoff.
# Signal evaluation and RBAC propagation take time after deployment.
# Saves all output to .healthmodel/data/deploy/smoke/ for investigation.
# Usage: smoke.sh <rg> <model> [--wait] [--timeout 600] [--interval 30]
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "${SKILL_DIR}/scripts/lib/arm.sh"

RG="${1:?resource group required}"
MODEL="${2:?model name required}"
shift 2

# Defaults: retry for up to 10 minutes, check every 30 seconds
WAIT=0; TIMEOUT=600; INTERVAL=30
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT=1; shift ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SUB=$(arm_sub)
DATA=".healthmodel/data/deploy/smoke"
mkdir -p "$DATA"

run_smoke() {
  local TIMESTAMP="$1"
  LIST_URL=$(arm_url "$SUB" "$RG" "$MODEL" entities)
  all_entities=$(arm_get "$LIST_URL")

  echo "$all_entities" | jq '.' > "$DATA/entities-$TIMESTAMP.json"

  unknown=0; healthy=0; degraded=0; unhealthy=0; errored=0
  REPORT="$DATA/smoke-$TIMESTAMP.txt"
  > "$REPORT"

  for row in $(printf '%s' "$all_entities" | jq -r '.value[]? | @base64'); do
    entity=$(printf '%s' "$row" | base64 -d)
    ename=$(printf '%s' "$entity" | jq -r '.name')
    printf '%s' "$entity" | jq '.' > "$DATA/entity-$ename.json"

    signals=$(printf '%s' "$entity" | jq -r '
      [.properties.signalGroups // {} | to_entries[].value.signals[]? |
        {name: .name, state: (.status.healthState // "Unknown"), value: .status.value, reason: .status.reason}] | .[] | @base64')

    for srow in $signals; do
      sig=$(printf '%s' "$srow" | base64 -d)
      sname=$(printf '%s' "$sig" | jq -r '.name')
      state=$(printf '%s' "$sig" | jq -r '.state')
      value=$(printf '%s' "$sig" | jq -r '.value // "n/a"')
      reason=$(printf '%s' "$sig" | jq -r '.reason // ""')
      case "$state" in
        Healthy)   healthy=$((healthy+1));   line="  ✓ $ename/$sname (value=$value)" ;;
        Degraded)  degraded=$((degraded+1)); line="  ~ $ename/$sname ($state, value=$value)" ;;
        Unhealthy) unhealthy=$((unhealthy+1)); line="  ✘ $ename/$sname ($state, value=$value)" ;;
        *)         unknown=$((unknown+1));   line="  ? $ename/$sname ($state, reason=$reason)" ;;
      esac
      echo "$line"
      echo "$line" >> "$REPORT"
    done
  done

  SUMMARY="summary: healthy=$healthy degraded=$degraded unhealthy=$unhealthy unknown=$unknown"
  echo ""
  echo "$SUMMARY"
  echo "$SUMMARY" >> "$REPORT"
  echo "report → $REPORT"

  # Return codes: 0=all good, 1=unhealthy, 2=unknown (retry-able)
  if [ "$unhealthy" -gt 0 ]; then
    return 1
  elif [ "$unknown" -gt 0 ]; then
    return 2
  else
    return 0
  fi
}

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [ "$WAIT" -eq 0 ]; then
  run_smoke "$TIMESTAMP"
  exit $?
fi

# Retry loop for --wait mode
echo "== smoke test with retry (timeout=${TIMEOUT}s, interval=${INTERVAL}s) =="
ELAPSED=0
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  set +e
  run_smoke "$TIMESTAMP"
  RC=$?
  set -e

  case "$RC" in
    0) echo ""; echo "✓ all signals healthy"; exit 0 ;;
    1) echo ""; echo "✘ unhealthy signals detected — failing immediately"; exit 1 ;;
    2)
      ELAPSED=$((ELAPSED + INTERVAL))
      if [ "$ELAPSED" -lt "$TIMEOUT" ]; then
        echo ""
        echo "  ⏳ unknown signals — retrying in ${INTERVAL}s (${ELAPSED}/${TIMEOUT}s elapsed)"
        sleep "$INTERVAL"
      fi
      ;;
  esac
done

echo ""
echo "✘ timeout: signals still Unknown after ${TIMEOUT}s — likely RBAC propagation or signal config issue"
exit 1
