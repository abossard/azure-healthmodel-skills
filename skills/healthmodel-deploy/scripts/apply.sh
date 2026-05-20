#!/usr/bin/env bash
# Apply the plan written by plan.sh. Skips no-ops. Asks confirmation by default.
# Usage: apply.sh [--yes] [--only kind/name]
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "${SKILL_DIR}/scripts/lib/arm.sh"

YES=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

PLAN=".healthmodel/04-plan.json"
[ -f "$PLAN" ] || { echo "no plan — run plan.sh first" >&2; exit 2; }

# Filter actionable items
FILTER='.[] | select(.verdict != "= no-op")'
[ -n "$ONLY" ] && FILTER="$FILTER | select(\"\(.kind)/\(.name)\" == \"$ONLY\")"

COUNT=$(jq "[ $FILTER ] | length" "$PLAN")

write_receipt() {
  local applied="$1"
  local noop sub
  noop=$(jq '[ .[] | select(.verdict == "= no-op") ] | length' "$PLAN")
  sub=$(arm_sub)
  cat > .healthmodel/04-deployed.json <<EOF
{
  "modelName": "$(jq -r '.[0].model // ""' "$PLAN")",
  "resourceGroup": "$(jq -r '.[0].rg // ""' "$PLAN")",
  "subscription": "$sub",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "appliedCount": $applied,
  "noopCount": $noop
}
EOF
  echo "receipt → .healthmodel/04-deployed.json"
}

if [ "$COUNT" -eq 0 ]; then
  echo "nothing to apply"
  write_receipt 0
  exit 0
fi

echo "$COUNT change(s) to apply:"
jq -r "$FILTER | \"  \(.verdict)  \(.kind)/\(.name)\"" "$PLAN"

if [ "$YES" -ne 1 ]; then
  printf "proceed? [y/N] " >&2; read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "aborted"; exit 1; }
fi

TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
jq -c "$FILTER" "$PLAN" | while read -r item; do
  url=$(jq -r '.url' <<<"$item")
  body=$(jq -r '.body' <<<"$item")
  printf '%s' "$body" > "$TMP"
  arm_put "$url" "$TMP" >/dev/null
  echo "  applied: $(jq -r '"\(.kind)/\(.name)"' <<<"$item")"
done

echo "done"

APPLIED=$(jq "[ $FILTER ] | length" "$PLAN")
write_receipt "$APPLIED"
