#!/usr/bin/env bash
# Check signal health for every entity by reading entity state from the GET response.
# Usage: smoke.sh <rg> <model>
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "${SKILL_DIR}/scripts/lib/arm.sh"

RG="${1:?resource group required}"
MODEL="${2:?model name required}"
SUB=$(arm_sub)

LIST_URL=$(arm_url "$SUB" "$RG" "$MODEL" entities)
all_entities=$(arm_get "$LIST_URL")

unknown=0; healthy=0; degraded=0; unhealthy=0; errored=0

# Extract per-signal health from entity response bodies
for row in $(printf '%s' "$all_entities" | jq -r '.value[]? | @base64'); do
  entity=$(printf '%s' "$row" | base64 -d)
  ename=$(printf '%s' "$entity" | jq -r '.name')

  # Walk all signal groups and extract signal status
  signals=$(printf '%s' "$entity" | jq -r '
    [.properties.signalGroups // {} | to_entries[].value.signals[]? |
      {name: .name, state: (.status.healthState // "Unknown")}] | .[] | @base64')

  for srow in $signals; do
    sig=$(printf '%s' "$srow" | base64 -d)
    sname=$(printf '%s' "$sig" | jq -r '.name')
    state=$(printf '%s' "$sig" | jq -r '.state')
    case "$state" in
      Healthy)   healthy=$((healthy+1));   echo "  ✓ $ename/$sname" ;;
      Degraded)  degraded=$((degraded+1)); echo "  ~ $ename/$sname ($state)" ;;
      Unhealthy) unhealthy=$((unhealthy+1)); echo "  ✘ $ename/$sname ($state)" ;;
      *)         unknown=$((unknown+1));   echo "  ? $ename/$sname ($state)" ;;
    esac
  done
done

echo
echo "summary: healthy=$healthy degraded=$degraded unhealthy=$unhealthy unknown=$unknown errored=$errored"
[ $((unhealthy+errored)) -eq 0 ] || exit 1
