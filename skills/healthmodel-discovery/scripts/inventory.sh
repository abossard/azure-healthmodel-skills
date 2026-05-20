#!/usr/bin/env bash
# Build resource inventory + minimal projection from .healthmodel/raw/all.json
# Usage: inventory.sh
set -euo pipefail

IN=".healthmodel/raw/all.json"
test -f "$IN" || { echo "$IN missing — run export-resources.sh first" >&2; exit 2; }

echo "== Type counts =="
jq -r 'group_by(.type) | map({type: .[0].type, count: length}) | sort_by(-.count) | .[] | "\(.count)\t\(.type)"' "$IN"

jq '[.[] | {id, name, type, location, rg: (.id | split("/")[4]), kind, tags, sku: .sku.name}]' "$IN" \
  > .healthmodel/resources.json
echo
echo "minimal projection → .healthmodel/resources.json"

echo
echo "== Stamps / location grouping =="
jq 'group_by(.tags.stamp // .rg // .location) | map({stamp: .[0].tags.stamp // .[0].rg // .[0].location, resources: [.[].type] | unique})' \
  .healthmodel/resources.json
