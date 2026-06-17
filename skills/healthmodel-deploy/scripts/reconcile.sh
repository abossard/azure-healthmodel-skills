#!/usr/bin/env bash
# Reconcile a .healthmodel/03-design/ tree against an Azure Health Model using
# the az monitor health-models extension. Each *.json file maps 1:1 to one
# `az monitor health-models <kind> create` invocation.
#
# `create` is idempotent (server treats it as full-PUT), so we run it
# unconditionally and let Azure compute the diff. Cross-references are
# server-validated, so reconcile order matters:
#   auth-setting -> signal-definition -> entity -> relationship -> discovery-rule
#
# Each design file's `properties` body is unwrapped into the matching --*-file
# arguments (e.g. .azureResourceMetric -> --azure-resource-metric).
#
# Usage: reconcile.sh <rg> <model> [--design .healthmodel/03-design]
#                                  [--location <loc>] [--dry-run]
set -euo pipefail

RG="${1:?resource group required}"
MODEL="${2:?model name required}"
shift 2

DESIGN=".healthmodel/03-design"
LOC=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --design)   DESIGN="$2"; shift 2 ;;
    --location) LOC="$2"; shift 2 ;;
    --dry-run)  DRY=1; shift ;;
    *)          echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

DATA=".healthmodel/data/deploy/reconcile"
mkdir -p "$DATA"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$DATA/reconcile-$TS.log"

run() {
  local label="$1"; shift
  if [ "$DRY" -eq 1 ]; then
    echo "  [dry-run] $label"
    printf '  $ az'; printf ' %q' "$@"; printf '\n'
    return 0
  fi
  echo "  · $label"
  if az "$@" >>"$LOG" 2>&1; then
    return 0
  fi
  echo "  ✘ failed: $label — see $LOG"
  tail -20 "$LOG" >&2
  return 1
}

# 0. Ensure model exists (idempotent create; locked to provided --location if model is new)
echo "== Reconciling $MODEL in $RG =="
if az monitor health-models show -g "$RG" -n "$MODEL" >/dev/null 2>&1; then
  echo "✓ Health model exists"
else
  [ -n "$LOC" ] || { echo "✘ Model not found and --location not provided" >&2; exit 1; }
  if [ "$DRY" -eq 1 ]; then
    echo "  [dry-run] would create model $MODEL in $LOC with SystemAssigned identity"
  else
    echo "Creating model in $LOC with SystemAssigned identity..."
    az monitor health-models create -g "$RG" -n "$MODEL" -l "$LOC" \
      --mi-system-assigned >>"$LOG" 2>&1
  fi
fi

# 1. authentication-setting/<name>.json -> az ... authentication-setting create
if [ -d "$DESIGN/auth" ]; then
  echo "-- authentication-setting --"
  for f in "$DESIGN"/auth/*.json; do
    [ -e "$f" ] || continue
    NAME="$(basename "$f" .json)"
    # camelCase keys: displayName, managedIdentityName, authenticationKind
    MI_NAME=$(jq -r '.managedIdentityName // "SystemAssigned"' "$f")
    DISPLAY=$(jq -r '.displayName // empty' "$f")
    ARGS=(monitor health-models authentication-setting create
          -g "$RG" --health-model-name "$MODEL" -n "$NAME"
          --managed-identity "managed-identity-name=$MI_NAME")
    [ -n "$DISPLAY" ] && ARGS+=(--display-name "$DISPLAY")
    run "auth $NAME (mi=$MI_NAME)" "${ARGS[@]}"
  done
fi

# 2. signal-definition/<name>.json -> az ... signal-definition create
if [ -d "$DESIGN/signals" ]; then
  echo "-- signal-definition --"
  for f in "$DESIGN"/signals/*.json; do
    [ -e "$f" ] || continue
    NAME="$(basename "$f" .json)"
    DISPLAY=$(jq -r '.displayName // empty' "$f")
    REFRESH=$(jq -r '.refreshInterval // empty' "$f")
    DATA_UNIT=$(jq -r '.dataUnit // empty' "$f")
    SIGNAL_KIND=$(jq -r '.signalKind // empty' "$f")
    ARGS=(monitor health-models signal-definition create
          -g "$RG" --health-model-name "$MODEL" -n "$NAME")
    [ -n "$DISPLAY" ] && ARGS+=(--display-name "$DISPLAY")
    [ -n "$REFRESH" ] && ARGS+=(--refresh-interval "$REFRESH")
    [ -n "$DATA_UNIT" ] && ARGS+=(--data-unit "$DATA_UNIT")

    # Sub-shape per signalKind: write a tmp file with the relevant body, pass via @path
    TMPDIR="$DATA/sd-$NAME"
    mkdir -p "$TMPDIR"
    case "$SIGNAL_KIND" in
      AzureResourceMetric|"")
        if jq -e '.metricName' "$f" >/dev/null 2>&1; then
          jq '{metricNamespace, metricName, aggregationType, timeGrain,
               dimension, dimensionFilter} | with_entries(select(.value != null))' \
            "$f" > "$TMPDIR/arm.json"
          ARGS+=(--azure-resource-metric "@$TMPDIR/arm.json")
        fi
        ;;
      PrometheusMetricsQuery)
        jq '{queryText, timeGrain} | with_entries(select(.value != null))' \
          "$f" > "$TMPDIR/prom.json"
        ARGS+=(--prometheus-metrics-query "@$TMPDIR/prom.json")
        ;;
      LogAnalyticsQuery)
        jq '{queryText, valueColumnName, timeGrain} |
            with_entries(select(.value != null))' \
          "$f" > "$TMPDIR/log.json"
        ARGS+=(--log-analytics-query "@$TMPDIR/log.json")
        ;;
    esac

    if jq -e '.evaluationRules' "$f" >/dev/null 2>&1; then
      jq '.evaluationRules' "$f" > "$TMPDIR/eval.json"
      ARGS+=(--evaluation-rules "@$TMPDIR/eval.json")
    fi
    run "signal $NAME ($SIGNAL_KIND)" "${ARGS[@]}"
  done
fi

# 3. entity/<name>.json -> az ... entity create
if [ -d "$DESIGN/entities" ]; then
  echo "-- entity --"
  for f in "$DESIGN"/entities/*.json; do
    [ -e "$f" ] || continue
    NAME="$(basename "$f" .json)"
    DISPLAY=$(jq -r '.displayName // empty' "$f")
    IMPACT=$(jq -r '.impact // "Standard"' "$f")
    HEALTH_OBJ=$(jq -r '.healthObjective // empty' "$f")
    ARGS=(monitor health-models entity create
          -g "$RG" --health-model-name "$MODEL" -n "$NAME"
          --impact "$IMPACT")
    [ -n "$DISPLAY" ] && ARGS+=(--display-name "$DISPLAY")
    [ -n "$HEALTH_OBJ" ] && ARGS+=(--health-objective "$HEALTH_OBJ")

    TMPDIR="$DATA/e-$NAME"
    mkdir -p "$TMPDIR"
    if jq -e '.signalGroups' "$f" >/dev/null 2>&1; then
      jq '.signalGroups' "$f" > "$TMPDIR/sg.json"
      ARGS+=(--signal-groups "@$TMPDIR/sg.json")
    fi
    if jq -e '.icon' "$f" >/dev/null 2>&1; then
      jq '.icon' "$f" > "$TMPDIR/icon.json"
      ARGS+=(--icon "@$TMPDIR/icon.json")
    fi
    if jq -e '.canvasPosition' "$f" >/dev/null 2>&1; then
      jq '.canvasPosition' "$f" > "$TMPDIR/canvas.json"
      ARGS+=(--canvas-position "@$TMPDIR/canvas.json")
    fi
    if jq -e '.alerts' "$f" >/dev/null 2>&1; then
      jq '.alerts' "$f" > "$TMPDIR/alerts.json"
      ARGS+=(--alerts "@$TMPDIR/alerts.json")
    fi
    run "entity $NAME (impact=$IMPACT)" "${ARGS[@]}"
  done
fi

# 4. relationship/<name>.json -> az ... relationship create
if [ -d "$DESIGN/relationships" ]; then
  echo "-- relationship --"
  for f in "$DESIGN"/relationships/*.json; do
    [ -e "$f" ] || continue
    NAME="$(basename "$f" .json)"
    PARENT=$(jq -r '.parentEntityName' "$f")
    CHILD=$(jq -r '.childEntityName' "$f")
    DISPLAY=$(jq -r '.displayName // empty' "$f")
    ARGS=(monitor health-models relationship create
          -g "$RG" --health-model-name "$MODEL" -n "$NAME"
          --parent-entity-name "$PARENT" --child-entity-name "$CHILD")
    [ -n "$DISPLAY" ] && ARGS+=(--display-name "$DISPLAY")
    run "relationship $NAME ($PARENT -> $CHILD)" "${ARGS[@]}"
  done
fi

# 5. discovery-rule/<name>.json -> az ... discovery-rule create
if [ -d "$DESIGN/discovery-rules" ]; then
  echo "-- discovery-rule --"
  for f in "$DESIGN"/discovery-rules/*.json; do
    [ -e "$f" ] || continue
    NAME="$(basename "$f" .json)"
    DISPLAY=$(jq -r '.displayName // empty' "$f")
    AUTH=$(jq -r '.authenticationSetting // empty' "$f")
    ADD_RECO=$(jq -r '.addRecommendedSignals // "Enabled"' "$f")
    DISC_REL=$(jq -r '.discoverRelationships // "Enabled"' "$f")
    ARGS=(monitor health-models discovery-rule create
          -g "$RG" --health-model-name "$MODEL" -n "$NAME"
          --add-recommended-signals "$ADD_RECO"
          --discover-relationships "$DISC_REL")
    [ -n "$AUTH" ] && ARGS+=(--authentication-setting "$AUTH")
    [ -n "$DISPLAY" ] && ARGS+=(--display-name "$DISPLAY")

    TMPDIR="$DATA/dr-$NAME"
    mkdir -p "$TMPDIR"
    if jq -e '.specification' "$f" >/dev/null 2>&1; then
      jq '.specification' "$f" > "$TMPDIR/spec.json"
      ARGS+=(--specification "@$TMPDIR/spec.json")
    fi
    run "discovery-rule $NAME" "${ARGS[@]}"
  done
fi

echo ""
echo "✓ reconcile complete — log: $LOG"
