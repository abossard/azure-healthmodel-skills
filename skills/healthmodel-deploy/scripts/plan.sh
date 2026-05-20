#!/usr/bin/env bash
# Produce a plan: for every design file, compute the merged body (live * design)
# and show what would change vs live. Writes .healthmodel/04-plan.json.
# Usage: plan.sh <rg> <model> [design-dir]
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "${SKILL_DIR}/scripts/lib/arm.sh"

RG="${1:?resource group required}"
MODEL="${2:?model name required}"
DESIGN="${3:-.healthmodel/03-design}"
SUB=$(arm_sub)
MERGE_JQ="${SKILL_DIR}/scripts/lib/merge.jq"

OUT=".healthmodel/04-plan.json"
mkdir -p "$(dirname "$OUT")"
echo '[]' > "$OUT"

plan_one() {
  local kind="$1" file="$2"
  local name; name=$(basename "$file" .json)
  local url; url=$(arm_url "$SUB" "$RG" "$MODEL" "$kind" "$name")
  local live merged verdict diff
  live=$(arm_get "$url")
  merged=$(jq -n --argjson l "$live" --argjson d "$(cat "$file")" '
    ($l // {}) as $live
    | (($live.properties // {}) * $d) as $props
    | { properties: $props }')
  if [ "$(jq 'has("properties") | not' <<<"$live")" = "true" ]; then
    verdict="+ create"; diff="(new resource)"
  else
    local cur new
    cur=$(jq -c '.properties' <<<"$live")
    new=$(jq -c '.properties' <<<"$merged")
    if [ "$cur" = "$new" ]; then
      verdict="= no-op"; diff=""
    else
      verdict="~ modify"
      diff=$(diff <(jq -S '.properties' <<<"$live") <(jq -S '.properties' <<<"$merged") || true)
    fi
  fi
  printf '  %s  %s/%s\n' "$verdict" "$kind" "$name"
  [ -n "$diff" ] && printf '%s\n' "$diff" | sed 's/^/      /'
  jq --arg k "$kind" --arg n "$name" --arg v "$verdict" --arg u "$url" \
     --arg f "$file" --arg rg "$RG" --arg model "$MODEL" --argjson m "$merged" \
     '. += [{kind:$k, name:$n, verdict:$v, url:$u, file:$f, rg:$rg, model:$model, body:$m}]' \
     "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
}

walk() {
  local subdir="$1" kind="$2"
  [ -d "$DESIGN/$subdir" ] || return 0
  shopt -s nullglob
  for f in "$DESIGN/$subdir"/*.json; do plan_one "$kind" "$f"; done
}

echo "== plan =="
walk auth          authenticationsettings
walk signals       signaldefinitions
walk entities      entities
walk relationships relationships

echo
echo "plan written → $OUT"
jq -r 'group_by(.verdict) | map("\(.[0].verdict): \(length)") | join("   ")' "$OUT"
