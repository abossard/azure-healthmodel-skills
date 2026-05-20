# PromQL Validation Guide

How to develop, test, and validate PromQL queries for health model signals using **only** `az rest` + `jq`. No Python, no curl, no extensions.

---

## Prerequisites

```bash
# Identify the Azure Monitor Workspace resource ID
AMW='/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Monitor/accounts/<amw>'

# Verify it exists and get the Prometheus endpoint
az rest --method GET \
  --url "https://management.azure.com${AMW}?api-version=2023-04-03" \
  -o json | jq '{
    name: .name,
    endpoint: .properties.metrics.prometheusQueryEndpoint,
    location: .location
  }'
```

If `endpoint` is `null`, the workspace has no Prometheus ingestion configured — you need to enable managed Prometheus on the AKS cluster first.

---

## Step 1: Discover available metrics

Before writing any PromQL signal, check what the AMW is actually receiving.

### List all metric names

```bash
ENDPOINT=$(az rest --method GET \
  --url "https://management.azure.com${AMW}?api-version=2023-04-03" \
  -o json | jq -r '.properties.metrics.prometheusQueryEndpoint')

# Get all metric names from the AMW metadata endpoint
az rest --method GET \
  --url "${ENDPOINT}/api/v1/label/__name__/values" \
  --resource "https://prometheus.monitor.azure.com" \
  -o json | jq '.data | sort'
```

### Check if a specific metric exists

```bash
METRIC='kube_pod_container_status_restarts_total'

az rest --method GET \
  --url "${ENDPOINT}/api/v1/query?query=${METRIC}" \
  --resource "https://prometheus.monitor.azure.com" \
  -o json | jq '.data.result | length'
```

A count `> 0` confirms the metric is being scraped. `0` means either:
- The metric name is wrong
- Prometheus scraping is not configured for that target
- The AKS cluster has no workloads emitting that metric

### List available labels for a metric

```bash
METRIC='kube_pod_container_status_restarts_total'

az rest --method GET \
  --url "${ENDPOINT}/api/v1/query?query=${METRIC}" \
  --resource "https://prometheus.monitor.azure.com" \
  -o json | jq '[.data.result[0].metric | keys[]]'
```

### List namespaces that have data

```bash
ENCODED=$(printf 'group by (namespace) (kube_pod_status_phase == 1)' | jq -Rr @uri)

az rest --method GET \
  --url "${ENDPOINT}/api/v1/query?query=${ENCODED}" \
  --resource "https://prometheus.monitor.azure.com" \
  -o json | jq '[.data.result[].metric.namespace]'
```

---

## Step 2: Test a query interactively

```bash
QUERY='sum(increase(kube_pod_container_status_restarts_total{namespace="prod"}[15m])) or vector(0)'
ENCODED=$(printf '%s' "$QUERY" | jq -Rr @uri)

az rest --method GET \
  --url "${ENDPOINT}/api/v1/query?query=${ENCODED}" \
  --resource "https://prometheus.monitor.azure.com" \
  -o json | jq '{
    status: .status,
    resultCount: (.data.result | length),
    value: .data.result[0].value[1],
    allResults: [.data.result[] | {metric: .metric, value: .value[1]}]
  }'
```

### Interpreting results

| `status` | `resultCount` | Meaning |
|-----------|---------------|---------|
| `success` | `>= 1` | ✅ Query works and has data |
| `success` | `0` | ⚠️ No matching series — but `or vector(0)` should prevent this |
| `error` | — | ❌ Query syntax error or auth failure |

### Common errors and fixes

| Error message | Cause | Fix |
|---|---|---|
| `parse error at char N` | PromQL syntax error | Check brackets, quotes, operator spacing |
| `unknown metric name` | Metric not scraped | Run Step 1 to list available metrics |
| `AuthenticationFailed` | Token lacks permissions | Assign `Monitoring Data Reader` on the AMW |
| `many-to-many matching not allowed` | Join cardinality mismatch | Add `group_left()` or `group_right()` |
| Empty result despite `or vector(0)` | `or vector(0)` placed inside subquery | Move `or vector(0)` to the outermost expression |

---

## Step 3: Validate the query produces a single scalar

Health model signals expect **one** value. If your query returns multiple series, the evaluator picks one arbitrarily.

```bash
az rest --method GET \
  --url "${ENDPOINT}/api/v1/query?query=${ENCODED}" \
  --resource "https://prometheus.monitor.azure.com" \
  -o json | jq '.data.result | length'
```

- **1** → correct — single scalar
- **0** → the `or vector(0)` should have caught this; check placement
- **> 1** → add `sum()`, `avg()`, `min()`, or `max()` to aggregate to a single value

---

## Step 4: Write the signal definition

Once the query validates, create the signal definition file:

```json
{
  "displayName": "AKS Pod Restarts",
  "signalKind": "PrometheusMetricsQuery",
  "dataUnit": "Count",
  "refreshInterval": "PT1M",
  "queryText": "sum(increase(kube_pod_container_status_restarts_total{namespace=\"prod\"}[15m])) or vector(0)",
  "timeGrain": "PT15M",
  "evaluationRules": {
    "degradedRule":  {"operator": "GreaterThan", "threshold": 1},
    "unhealthyRule": {"operator": "GreaterThan", "threshold": 5}
  }
}
```

### Checklist before saving

- [ ] Query ends with `or vector(0)`
- [ ] Query returns exactly 1 series (use `sum()`/`avg()`/etc.)
- [ ] `timeGrain` matches the PromQL range window (`[5m]` → `PT5M`, `[15m]` → `PT15M`)
- [ ] Thresholds are integers
- [ ] Degraded trips before unhealthy (same direction)
- [ ] Namespace is hard-coded (no `$NS` variables)
- [ ] No `irate()` — too noisy for health evaluation

---

## Step 5: Validate all PromQL signals in the design

Use the automated validation script to test every `PrometheusMetricsQuery` signal against a live AMW:

```bash
bash .agents/skills/healthmodel-deploy/scripts/validate-promql.sh "$AMW"
# or with a custom design directory:
bash .agents/skills/healthmodel-deploy/scripts/validate-promql.sh "$AMW" .healthmodel/03-design
```

The script:
1. Finds all signal files with `signalKind: "PrometheusMetricsQuery"`
2. Executes each `queryText` against the AMW via `az rest`
3. Reports pass/fail/skip per signal
4. Marks failing signals with `(broken)` in `displayName`

### What counts as a failure

| Result | Treatment |
|---|---|
| `status: "success"`, any value (including `0`) | ✅ Pass — `or vector(0)` working correctly |
| `status: "error"` (parse error, auth failure) | ❌ Fail — mark as `(broken)` |
| `az rest` returns non-zero exit code | ❌ Fail — likely AMW unreachable or auth issue |

### What does NOT count as a failure

- A result of `0` — that's correct behavior from `or vector(0)` when no pods are crashing, etc.
- An empty result array when the query has `or vector(0)` — this shouldn't happen, but if it does, it's still a valid query.

---

## The "(broken)" marking convention

When a PromQL query cannot be validated (parse error, metric not found, auth failure), the signal is still valuable to keep in the design — it documents the intended monitoring. But it must be clearly marked:

```json
{
  "displayName": "AKS Pod Restarts (broken)",
  "signalKind": "PrometheusMetricsQuery",
  "queryText": "sum(increase(kube_pod_container_status_restarts_total{namespace=\"prod\"}[15m])) or vector(0)",
  ...
}
```

The `(broken)` suffix in `displayName`:
- Is visible in the Azure portal health model view
- Signals to operators that this metric needs investigation
- Should be removed once the query is validated against a working AMW
- `validate-promql.sh` adds it automatically on failure

To fix a broken signal:
1. Run the discovery queries (Step 1) to check what metrics are available
2. Adjust the query to match available metrics
3. Re-run `validate-promql.sh` — it removes `(broken)` on success

---

## Reusable helpers

### Get the Prometheus endpoint for an AMW (use in all recipes)

```bash
prom_endpoint() {
  az rest --method GET \
    --url "https://management.azure.com${1}?api-version=2023-04-03" \
    -o json | jq -r '.properties.metrics.prometheusQueryEndpoint'
}
ENDPOINT=$(prom_endpoint "$AMW")
```

### Run a PromQL query and extract the scalar value

```bash
prom_query() {
  local endpoint="$1" query="$2"
  local encoded
  encoded=$(printf '%s' "$query" | jq -Rr @uri)
  az rest --method GET \
    --url "${endpoint}/api/v1/query?query=${encoded}" \
    --resource "https://prometheus.monitor.azure.com" \
    -o json
}

# Usage:
prom_query "$ENDPOINT" 'sum(kube_pod_container_status_restarts_total) or vector(0)' \
  | jq '.data.result[0].value[1]'
```

---

## Cross-references

- [promql-cheatsheet.md](./promql-cheatsheet.md) — copy-pasteable Kubernetes PromQL patterns
- [metrics.md](./metrics.md) — Recipe 5 (probe PromQL against AMW), Recipe 10 (local sanity check)
- `healthmodel-deploy/scripts/validate-promql.sh` — automated validation script
- `healthmodel-design/SKILL.md` Step 1b — AKS PromQL signal generation
