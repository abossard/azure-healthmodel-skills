#!/usr/bin/env bash
# Check signal health for every entity by reading entity state from the GET response.
# Saves all output to .healthmodel/data/deploy/smoke/ for investigation.
# Usage: smoke.sh <rg> <model>
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "${SKILL_DIR}/scripts/lib/arm.sh"

RG="${1:?resource group required}"
MODEL="${2:?model name required}"
SUB=$(arm_sub)

DATA=".healthmodel/data/deploy/smoke"
mkdir -p "$DATA"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

LIST_URL=$(arm_url "$SUB" "$RG" "$MODEL" entities)
all_entities=$(arm_get "$LIST_URL")

# Save the raw entity response
echo "$all_entities" | jq '.' > "$DATA/entities-$TIMESTAMP.json"
echo "raw entity data → $DATA/entities-$TIMESTAMP.json"

unknown=0; healthy=0; degraded=0; unhealthy=0; errored=0
REPORT="$DATA/smoke-$TIMESTAMP.txt"

# Extract per-signal health from entity response bodies
for row in $(printf '%s' "$all_entities" | jq -r '.value[]? | @base64'); do
  entity=$(printf '%s' "$row" | base64 -d)
  ename=$(printf '%s' "$entity" | jq -r '.name')

  # Save individual entity data
  printf '%s' "$entity" | jq '.' > "$DATA/entity-$ename.json"

  # Walk all signal groups and extract signal status
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

SUMMARY="summary: healthy=$healthy degraded=$degraded unhealthy=$unhealthy unknown=$unknown errored=$errored"
echo
echo "$SUMMARY"
echo "$SUMMARY" >> "$REPORT"
echo "report → $REPORT"
[ $((unhealthy+errored)) -eq 0 ] || exit 1
