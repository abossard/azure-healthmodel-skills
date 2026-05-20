# Sourced helpers for ARM REST calls against Microsoft.CloudHealth.
# Source from peer scripts: source "$(dirname "$0")/lib/arm.sh"

API_VERSION="2026-01-01-preview"

# arm_url <sub> <rg> <model> [<kind>] [<name>]
#   Returns the ARM URL for the model root or a child resource.
#   kind: healthmodels(root)|authenticationsettings|signaldefinitions|entities|relationships
arm_url() {
  local sub="$1" rg="$2" model="$3" kind="${4:-}" name="${5:-}"
  local base="https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.CloudHealth/healthModels/${model}"
  if [ -n "$kind" ] && [ "$kind" != "healthmodels" ]; then
    base="${base}/${kind}"
    [ -n "$name" ] && base="${base}/${name}"
  fi
  printf '%s?api-version=%s\n' "$base" "$API_VERSION"
}

# arm_get <url>   → JSON body on stdout; empty object on 404.
arm_get() {
  local out
  if out=$(az rest --method GET --url "$1" --only-show-errors 2>&1); then
    printf '%s' "$out"
  else
    case "$out" in
      *ResourceNotFound*|*NotFound*|*Not\ Found*|*ResourceReadFailed*) printf '{}' ;;
      *) printf '%s\n' "$out" >&2; return 1 ;;
    esac
  fi
}

# arm_put <url> <body-json-file>
arm_put() {
  az rest --method PUT --url "$1" --body @"$2" --headers "Content-Type=application/json"
}

# arm_post <url> [body-json-file]
arm_post() {
  if [ -n "${2:-}" ]; then
    az rest --method POST --url "$1" --body @"$2" --headers "Content-Type=application/json"
  else
    az rest --method POST --url "$1"
  fi
}

# arm_sub → current subscription id
arm_sub() { az account show --query id -o tsv; }

# signal_template <body.json> → matching templates/<file>.bicep basename
signal_template() {
  case "$(jq -r '.signalKind // ""' "$1")" in
    AzureResourceMetric)     echo "signal-arm.bicep" ;;
    PrometheusMetricsQuery)  echo "signal-prom.bicep" ;;
    LogAnalyticsQuery)       echo "signal-log.bicep" ;;
    *) echo "unknown signalKind in $1" >&2; return 1 ;;
  esac
}
