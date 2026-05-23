#!/usr/bin/env bash
# Validate every sparse design file against its bicep schema (offline),
# then validate the full Bicep project if it exists.
# Usage: validate.sh [design-dir]   (default: .healthmodel/03-design)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATES="${SKILL_DIR}/templates"
DESIGN="${1:-.healthmodel/03-design}"
BICEP_PROJECT=".healthmodel/05-bicep"

# shellcheck source=lib/arm.sh
. "${SKILL_DIR}/scripts/lib/arm.sh"

[ -d "$DESIGN" ] || { echo "design dir missing: $DESIGN" >&2; exit 2; }
command -v az >/dev/null     || { echo "az required" >&2; exit 127; }
command -v jq >/dev/null     || { echo "jq required" >&2; exit 127; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail=0

check() {
  local template="$1" body="$2"
  local stage="$TMP/$(basename "$template" .bicep)__$(basename "$body" .json)"
  mkdir -p "$stage"
  cp "${TEMPLATES}/$template" "$stage/template.bicep"
  cp "$body" "$stage/body.json"
  local out
  if ! out=$(az bicep build --file "$stage/template.bicep" --stdout 2>&1); then
    echo "  ✘ $body — bicep error"
    echo "$out" | grep -E "ERROR" | sed 's/^/      /'
    return 1
  fi
  if echo "$out" | grep -qE "Warning BCP"; then
    echo "  ✘ $body"
    echo "$out" | grep "Warning BCP" | sed 's/^/      /'
    return 1
  fi
  echo "  ✓ $body"
}

walk() {
  local subdir="$1" template_arg="$2" template
  [ -d "$DESIGN/$subdir" ] || return 0
  echo "$subdir/"
  shopt -s nullglob
  for f in "$DESIGN/$subdir"/*.json; do
    if [ "$template_arg" = "@signal" ]; then
      template=$(signal_template "$f") || { fail=1; continue; }
    else
      template="$template_arg"
    fi
    check "$template" "$f" || fail=1
  done
}

echo "== validating individual design files =="
walk auth          "auth.bicep"
walk signals       "@signal"
walk entities      "entity.bicep"
walk relationships "relationship.bicep"

# Validate the full Bicep project if it exists
if [ -d "$BICEP_PROJECT" ] && [ -f "$BICEP_PROJECT/main.bicep" ]; then
  echo ""
  echo "== validating full Bicep project =="
  if ! out=$(az bicep build --file "$BICEP_PROJECT/main.bicep" --stdout 2>&1); then
    echo "  ✘ $BICEP_PROJECT/main.bicep — bicep error"
    echo "$out" | grep -E "ERROR|Warning BCP" | sed 's/^/      /'
    fail=1
  elif echo "$out" | grep -qE "Warning BCP"; then
    echo "  ✘ $BICEP_PROJECT/main.bicep — warnings"
    echo "$out" | grep "Warning BCP" | sed 's/^/      /'
    fail=1
  else
    echo "  ✓ $BICEP_PROJECT/main.bicep — full project validates clean"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "validation failed — fix schema errors above"
  exit 1
fi
echo
echo "all design files validate clean"
