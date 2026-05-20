---
name: healthmodel-signal-catalog
description: "Discovery-driven reference for building Azure Monitor Health Model signals. Shows how to discover metrics with `az monitor metrics list-definitions`, write PromQL / KQL that the design schema accepts, derive thresholds from real data, and verify signals after deploy via `az rest`. WHEN: loaded by healthmodel-design when authoring signal definitions for any resource type. DO NOT USE FOR: direct user invocation, deploying signals (use healthmodel-deploy), discovering resources (use healthmodel-discovery)."
disable-model-invocation: true
---

# Signal Catalog — Discovery Recipes

Reference data for **healthmodel-design**. Instead of a frozen table of resource-types → metrics, this skill teaches the design phase **how to discover, evaluate, and verify signals for any Azure resource** using only the standard `az` CLI, `jq`, and `az rest`. Loaded by other skills — not invoked directly by users.

## Why discovery-driven

- Azure adds, renames, and deprecates metrics constantly — any frozen catalog goes stale.
- Niche resource types (Container Apps, AI Foundry, App Configuration, Logic Apps, …) never made it into hand-maintained tables.
- A discovered metric definition tells you the exact `metricNamespace`, supported aggregations, unit, and dimensions — which is what the signal-definition schema actually needs.
- Real metric samples beat invented thresholds.

## Rules

1. ⛔ MANDATORY: Direction is the source of truth — `higher-is-worse` → `GreaterThan`; `lower-is-worse` → `LessThan`. Pick direction **before** the threshold.
2. ⛔ MANDATORY: `degraded` is the early warning; `unhealthy` means action required. Degraded must trip strictly before unhealthy on the same direction.
3. ⛔ MANDATORY: Every PromQL query ends with `or vector(0)` so absence-of-data evaluates to `0`, not `Unknown`. Same for KQL — return `0` on empty time-bucket via `make-series` or a `coalesce` projection.
4. ⛔ MANDATORY: Azure-Metric signals use the **exact** `metricName` and `metricNamespace` from `az monitor metrics list-definitions`. Fields go **flat under `properties`** — no `azureResourceMetric`/`prometheusMetricsQuery`/`logAnalyticsQuery` sub-object. `healthmodel-deploy/scripts/validate.sh` (Bicep) enforces this.
5. ⛔ MANDATORY: `aggregationType` must be one of the values listed in the metric definition's `supportedAggregationTypes`. Using an unsupported aggregation silently returns null and the signal goes `Unknown`.
6. ⛔ MANDATORY: Thresholds are integer-typed in JSON (`100`, not `"100"`). Bicep rejects strings. See [Threshold design](#5-threshold-design) for handling sub-integer cases.
7. ⛔ MANDATORY: Don't reference dimensions in the signal-definition body. The ARM-metric path of the schema has **no dimension filter** — `TotalRequests dim=StatusCode=429` cannot be expressed. Pick a metric that is already pre-filtered (e.g., `Http5xx` instead of `Requests dim=StatusCode=5xx`), or switch the signal to KQL / PromQL.
8. ⛔ MANDATORY: Use only standard `az` CLI commands — `az monitor metrics list-definitions`, `az monitor metrics list`, `az rest`. No extensions, no Python SDK.
9. ⛔ MANDATORY: Never use `grep` or `sed` to parse `az` JSON output — always `jq`.
10. ⛔ MANDATORY: For resource types you can't immediately classify, mark the signal `"_review": "needs human review — auto-derived"`, set entity `impact` to `Limited`, and document the rationale next to the design file.

## What this skill is consumed by

`healthmodel-design` reads this file when authoring `.healthmodel/03-design/signals/*.json`. The contract is:

- **AzureResourceMetric** signals → use Section 1 (discovery) and Section 5 (thresholds).
- **PrometheusMetricsQuery** signals → use Section 2 (PromQL) and Section 5.
- **LogAnalyticsQuery** signals → use Section 3 (KQL) and Section 5.
- After deploy → use Section 4 to verify each signal actually returns `Healthy` / `Degraded` / `Unhealthy` (not `Unknown`).

---

## 1. Metric discovery via `az` CLI

### 1.1 List every metric available on a resource

```bash
RID='/subscriptions/<sub>/resourceGroups/<rg>/providers/<provider>/<type>/<name>'

az monitor metrics list-definitions --resource "$RID" -o json \
  | jq '[.[] | {
        name: .name.value,
        displayName: .name.localizedValue,
        namespace: .metricNamespace,
        unit,
        primaryAgg: .primaryAggregationType,
        aggs: .supportedAggregationTypes,
        dims: [.dimensions[]?.value]
      }]'
```

The four fields you actually paste into a signal definition come from this output:

| Signal field | Comes from |
|---|---|
| `metricName` | `.name.value` (case-sensitive) |
| `metricNamespace` | `.metricNamespace` (lowercase ARM type, e.g. `microsoft.documentdb/databaseaccounts`) |
| `dataUnit` | `.unit` mapped to schema enum (`Percent`, `Count`, `MilliSeconds`, `Bytes`, `Seconds`, `BytesPerSecond`, `CountPerSecond`) |
| `aggregationType` | One of `.supportedAggregationTypes` — pick the one that matches the **direction** (see Section 5) |

### 1.2 Sample real metric values (last 1 h, 5-minute grain)

```bash
az monitor metrics list \
  --resource "$RID" \
  --metric "ServiceAvailability" \
  --aggregation Average \
  --interval PT5M \
  --start-time "$(date -u -v-1H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%SZ')" \
  -o json \
  | jq '[.value[0].timeseries[0].data[] | select(.average != null) | .average]
        | { n: length, min: min, max: max, avg: (add/length) }'
```

The macOS / Linux `date` fallback above is intentional — `-v-1H` is BSD, `-d '1 hour ago'` is GNU. Both shells used by the orchestrator hit one of the two.

Use this baseline window when proposing thresholds — see Section 5.

### 1.3 Spot golden-signal candidates by name and unit

After dumping definitions, classify with `jq`:

```bash
az monitor metrics list-definitions --resource "$RID" -o json | jq '
  def classify(n; u):
    if   (n | test("avail"; "i"))                                       then "availability"
    elif (n | test("latency|duration|responsetime|e2e|ttlt|ttft|tbt|timetoresponse|timetolast|timebetween"; "i"))
                                                                        then "latency"
    elif (n | test("error|fail|5xx|4xx|exception|deadletter|rejected"; "i"))
                                                                        then "errors"
    elif (n | test("throttle|429|busy|provisioned.*utilization|ptu"; "i"))
                                                                        then "saturation"
    elif (n | test("cpu|memory|connections|load|ru|queue|backlog"; "i")) then "saturation"
    elif (n | test("tokenpersecond"; "i"))                               then "throughput"
    elif (n | test("token|prompt|completion|generated|inference"; "i"))  then "usage"
    elif (n | test("rai|harmful|abusive|contentsafety"; "i"))           then "safety"
    elif (n | test("cache.*match|cache.*rate"; "i"))                    then "efficiency"
    elif (u == "Percent")                                               then "ratio"
    else "other" end;
  [.[] | {
     golden: classify(.name.value; .unit),
     name: .name.value,
     unit, primaryAgg: .primaryAggregationType
   }] | sort_by(.golden, .name) | group_by(.golden)
       | map({(.[0].golden): map({name, unit, primaryAgg})}) | add'
```

Goal: pick **one** signal per golden-signal category that matters for this resource. Don't ship 20 signals per entity — pick the 2-4 that drive a user-facing SLO.

### 1.4 Generic "did I miss anything obvious?" filter

```bash
az monitor metrics list-definitions --resource "$RID" -o json \
  | jq -r '.[].name.value' \
  | awk 'tolower($0) ~ /avail|error|fail|throttle|latency|5xx|429|deadletter|busy|token|rai|harmful|rejected|ptu|utilization|ttft|ttlt/ {print}'
```

Anything this prints that is **not** in your design is a candidate for review.

### 1.5 When the schema can't express what you need

The `AzureResourceMetric` body has **no** field for dimension filters or metric ratios. If the only useful signal is `TotalRequests` split by `StatusCode=429`, do **one** of:

- Find a pre-aggregated metric without dimensions (e.g., `ThrottledRequests`, `Http5xx`, `ClientErrors`). Check `list-definitions` first.
- Switch the signal to **LogAnalyticsQuery** against the resource's diagnostic logs (Section 3).
- Switch to **PrometheusMetricsQuery** if the resource is in AKS and metrics are scraped (Section 2).

Don't smuggle a dimension into `metricName` — Bicep validation passes but the query returns null and the signal goes `Unknown` forever.

### 1.6 Event-based metrics (emit only on condition)

Some ARM metrics only produce data points when the condition is **active**. Examples:

- `cluster_autoscaler_unschedulable_pods_count` — emits only when unschedulable pods exist
- `FailedPodCounts` — emits only when pods are failing
- Various alert/trigger-count metrics

When the condition is absent, the metric has **no data** and the signal evaluates to `Unknown` (not `Healthy`).

**For AzureResourceMetric signals**: There is no "default to 0" mechanism. These metrics **cannot** be reliably used with `AzureResourceMetric` signal kind.

**Workarounds**:
1. **PromQL** (preferred): Use the equivalent Prometheus metric with `or vector(0)` — e.g., `kube_pod_status_unschedulable or vector(0)`.
2. **KQL**: Query the metric ingestion logs with a `coalesce(count, 0)` pattern.
3. **Accept Unknown as OK**: Document in the entity design that `Unknown` means "no data = healthy condition" — but this creates noise in the health model dashboard.

Always prefer option 1 or 2. If you must use option 3, set the entity `impact` to `Suppressed` so Unknown doesn't escalate.

### 1.7 AI service idle pattern (no traffic = no data ≠ event-based)

AI services (Azure OpenAI, AI Search, Document Intelligence) behave differently from truly event-based metrics. Their metrics are **registered** in `list-definitions` and have valid definitions, but return **zero data points** when the service receives no API traffic. This is distinct from §1.6:

| Pattern | `list-definitions` | Data when idle | Data when active | Example |
|---|---|---|---|---|
| Event-based (§1.6) | May or may not appear | No data | Emits only when condition fires | `FailedPodCounts` |
| AI service idle | Always appears | No data (0 samples) | Normal time-series | `AzureOpenAIRequests`, `SearchLatency` |
| Standard metric | Always appears | Emits `0` or baseline value | Normal time-series | `CpuPercentage`, `ServiceAvailability` |

**Detection**: Run Recipe 3 (sample 1h baseline) against the resource. If `n: 0` for all golden-signal candidates, the resource is idle — not broken.

**Handling idle AI resources**:
1. **Suppress until traffic starts**: Set entity `impact` to `Suppressed` with a note. After traffic begins, promote to `Limited` or `Standard`.
2. **KQL with zero-guard**: Use diagnostic logs (if configured) with `coalesce(count(), 0)` to return 0 instead of empty.
3. **Synthetic health-check**: Generate minimal traffic (e.g., a simple completions call on a schedule) so metrics always have data. This is operationally heavier but eliminates Unknown signals.
4. **Separate idle vs live entities**: If only some deployments are active, use `ModelDeploymentName` dimension filtering via KQL to scope signals to active deployments only.

> **⚠️ Do not confuse idle with broken**: An `Unknown` signal on an AI resource often means "no traffic in the evaluation window" — not a misconfigured signal or missing RBAC. Check Recipe 3 baseline data before debugging RBAC or signal definitions.

### 1.8 CognitiveServices metric namespace split

Azure OpenAI resources (`Microsoft.CognitiveServices/accounts` with `kind=OpenAI`) expose **two** sets of metrics under different logical categories:

- **Legacy** (category `Cognitive Services - HTTP Requests`): `Latency`, `SuccessfulCalls`, `BlockedCalls`, `TotalCalls`, `TotalErrors` — these are generic Cognitive Services metrics designed for Speech, Vision, etc. **Do not use these for Azure OpenAI** — they produce misleading results (e.g., `Latency` averages across all API operations, not just chat completions).
- **Modern** (categories `Azure OpenAI - *`): `AzureOpenAIRequests`, `AzureOpenAITimeToResponse`, `AzureOpenAITTLTInMS`, `ProcessedPromptTokens`, `GeneratedTokens`, `AzureOpenAIProvisionedManagedUtilizationV2`, etc. — **use these exclusively**.
- **Foundry Models** (if deployed via AI Foundry): `ModelRequests`, `InputTokens`, `OutputTokens`, `TimeToResponse`, `ProvisionedUtilization` — covers non-OpenAI models (DeepSeek, Phi, etc.) under the `Models` category.
- **Content Safety**: `RAIHarmfulRequests`, `RAIRejectedRequests`, `RAITotalRequests` — available under the `ContentSafety - Risks & Safety` category.

**To filter for the right metrics**, use Recipe 12 (namespace discovery) and prefix-match:

```bash
# Show only modern Azure OpenAI metrics
az monitor metrics list-definitions --resource "$RID" -o json \
  | jq '[.[] | select(.name.value | test("^AzureOpenAI|^Processed|^Generated|^Token|^Active|^Audio|^RAI|^FineTuned"; "i"))
         | {name: .name.value, category: .category, unit, primaryAgg: .primaryAggregationType}]'
```

> **DS Export limitations**: Several high-value OpenAI metrics have `DS Export = No` and **cannot** be sent to Log Analytics via diagnostic settings: `AzureOpenAIAvailabilityRate`, `AzureOpenAIProvisionedManagedUtilizationV2`, `AzureOpenAIContextTokensCacheMatchRate`. These must be monitored via ARM metric signals or direct `az monitor metrics list` queries — KQL signals will not work for them.

---

## 2. PromQL best practices

Used by `PrometheusMetricsQuery` signal kind. The AMW resource ID lives on the **entity's** `signalGroups.azureMonitorWorkspace.azureMonitorWorkspaceResourceId` — not on the signal definition.

### 2.1 The `or vector(0)` pattern

Every query **must** return at least one sample, otherwise the health model marks the signal `Unknown` instead of `Healthy`:

```promql
sum(rate(kube_pod_container_status_restarts_total{namespace="prod"}[5m])) or vector(0)
```

Apply `or vector(0)` to the **outermost** scalar/instant-vector expression — not inside a sub-query. If your expression collapses to an instant-vector with zero series, `or vector(0)` substitutes a single `0` sample.

### 2.2 Rate vs increase for counters

| Use | When |
|---|---|
| `rate(x[5m])` | Per-second rate. Pair with `sum()` for entity-wide rate. Aggregation `Average` over `PT5M`. |
| `increase(x[15m])` | Total count over a window. Use for "did anything fail in the last 15 min?". Aggregation `Total` over `PT15M`. |
| `irate(x[5m])` | **Avoid** — picks last 2 samples, too noisy for health evaluation. |

Match the `timeGrain` on the signal definition to the bracketed window: `[5m]` → `timeGrain: PT5M`.

### 2.3 Namespace and label filtering

```promql
sum(kube_pod_container_status_waiting_reason{
  namespace="$NS",                     # required — without it the signal sums every workload
  reason="CrashLoopBackOff"
}) or vector(0)
```

Hard-code `$NS` to the actual namespace string when writing the design file — variables aren't substituted by the health model evaluator.

### 2.4 Ratios (e.g., CPU throttling %)

```promql
100 *
  sum(rate(container_cpu_cfs_throttled_periods_total{namespace="prod"}[5m]))
/ sum(rate(container_cpu_cfs_periods_total{namespace="prod"}[5m]))
or vector(0)
```

Multiply by `100` so the result is in percent — that matches `dataUnit: "Percent"` and lets you use integer thresholds (`20`, `50`).

### 2.5 Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Missing `or vector(0)` | Signal flaps to `Unknown` whenever the metric is absent (e.g., zero pods crashed) | Always append `or vector(0)`. |
| Forgot `sum()` / `avg()` | Query returns multiple series per pod/replica → evaluator picks one arbitrarily | Aggregate to a single value. |
| High-cardinality label in selector | Slow query, timeouts visible as `Unknown` | Drop the dimension or pin it to a single value. |
| `aggregationType` does not match the math | Signal returns a different number than the portal preview | For `rate(...)` use `Average`; for `increase(...)` use `Total`. |

### 2.6 Test PromQL against the AMW before deploying

Uses `az rest` with `--resource` for authentication — no curl, no Python, no tokens to manage:

```bash
AMW='/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Monitor/accounts/<amw>'

# Get the Prometheus endpoint
ENDPOINT=$(az rest --method GET \
  --url "https://management.azure.com${AMW}?api-version=2023-04-03" \
  -o json | jq -r '.properties.metrics.prometheusQueryEndpoint')

# URL-encode the query with jq (no python)
QUERY='sum(rate(kube_pod_container_status_restarts_total{namespace="prod"}[5m])) or vector(0)'
ENCODED=$(printf '%s' "$QUERY" | jq -Rr @uri)

# Execute
az rest --method GET \
  --url "${ENDPOINT}/api/v1/query?query=${ENCODED}" \
  --resource "https://prometheus.monitor.azure.com" \
  -o json | jq '.data.result'
```

A non-empty `result` array means the query is wired correctly. A `[{"value":[..,"0"]}]` result (from `or vector(0)`) is still healthy — the signal will report `0`.

For batch validation of all PromQL signals in a design, use the automated script:

```bash
bash .agents/skills/healthmodel-deploy/scripts/validate-promql.sh "$AMW"
```

See [references/promql-validation.md](./references/promql-validation.md) for the full development workflow.

### 2.7 AKS / Kubernetes PromQL signal catalog

When the architecture graph contains `Microsoft.ContainerService/managedClusters` **and** `Microsoft.Monitor/accounts`, design PromQL signals instead of (or in addition to) ARM metric signals for AKS-specific health.

See [references/promql-cheatsheet.md](./references/promql-cheatsheet.md) for ready-to-use queries organized by signal category:

| Category | Example signals | Cheatsheet section |
|---|---|---|
| Pod health | Restarts, OOMKilled, CrashLoopBackOff, Pending | §2 |
| CPU & Memory | CPU vs requests %, throttling %, memory vs limits % | §3 |
| Node pressure | Pods on high-CPU/memory nodes, DiskPressure, NotReady | §4 |
| Deployment & scaling | Min replicas, unavailable replicas, HPA ceiling | §5 |
| Networking | Container network errors, Istio 5xx/4xx, P99 latency | §6 |
| Cert Manager | Days to expiry, certificates not ready | §7 |

Start with pod health + CPU/memory (the highest-signal categories), then layer in node pressure and networking based on the brief's golden-signal priority (§7 of the interview).

### 2.8 PromQL development workflow

1. **Discover** — list available metrics with `az rest` against `{endpoint}/api/v1/label/__name__/values` (see [promql-validation.md](./references/promql-validation.md) Step 1).
2. **Explore** — use discovery queries from the [cheatsheet §1](./references/promql-cheatsheet.md#1--discovery--investigation-queries) to understand what namespaces and labels have data.
3. **Draft** — pick a query from the cheatsheet, substitute the real namespace.
4. **Test** — run the query via `az rest` (§2.6 above) and verify: `status=success`, exactly 1 result series, reasonable value.
5. **Write** — create the signal-definition JSON (see `healthmodel-design/SKILL.md` Step 1).
6. **Validate** — run `validate-promql.sh` to batch-test all PromQL signals.
7. **Mark broken** — if a query fails validation, the script marks it `(broken)` in `displayName`. See §2.9.

### 2.9 The "(broken)" marking convention

If a PromQL query cannot be validated (metric not scraped, parse error, AMW unreachable), the signal is still valuable to keep in the design — it documents the monitoring intent. Mark it clearly:

```json
{
  "displayName": "AKS Pod Restarts (broken)",
  "signalKind": "PrometheusMetricsQuery",
  "queryText": "sum(increase(kube_pod_container_status_restarts_total{namespace=\"prod\"}[15m])) or vector(0)"
}
```

Rules:
- `(broken)` goes in `displayName`, visible in the Azure portal.
- `validate-promql.sh` adds/removes the marker automatically.
- A broken signal still deploys — it will show `Unknown` in the health model until the underlying issue is fixed.
- To fix: check if the AMW is receiving the metric (Step 1 of the [validation guide](./references/promql-validation.md)), adjust the query, re-run validation.

---

## 3. Log Analytics (KQL) best practices

Used by `LogAnalyticsQuery` signal kind. The workspace ID lives on the entity's `signalGroups.azureLogAnalytics.logAnalyticsWorkspaceResourceId`.

### 3.1 Shape: one scalar column the evaluator can compare

```kusto
AppExceptions
| where TimeGenerated > ago(5m)
| summarize Count = count()
```

The design file must specify which column to read:

```json
{
  "signalKind": "LogAnalyticsQuery",
  "queryText": "AppExceptions | where TimeGenerated > ago(5m) | summarize Count=count()",
  "valueColumnName": "Count",
  "timeGrain": "PT5M",
  "dataUnit": "Count"
}
```

`valueColumnName` is **case-sensitive** and must match the projected column name.

### 3.2 Always project zero on empty

KQL `summarize count()` already returns one row with `0` when there are no matches — but only if the table itself has rows in the time window. For tables that may have **no** rows at all (e.g., `AppExceptions` on a fresh app), force a zero row:

```kusto
AppExceptions
| where TimeGenerated > ago(5m)
| summarize Count = count()
| union (print Count = 0)
| summarize Count = sum(Count)
```

This guarantees the signal returns `0` instead of `Unknown` on cold tables.

### 3.3 Time grain alignment

`timeGrain` on the signal must align with the `ago()` window in the query. If you `summarize` over 5 min, set `timeGrain: PT5M`. Mismatches cause the evaluator to re-window the data and return surprising numbers.

### 3.4 Test KQL before deploying

```bash
WS_ID="$(az monitor log-analytics workspace show \
  --ids '/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<ws>' \
  -o json | jq -r '.customerId')"

az monitor log-analytics query --workspace "$WS_ID" \
  --analytics-query 'AppExceptions | where TimeGenerated > ago(5m) | summarize Count=count()' \
  -o json \
  | jq '.tables[0].rows'
```

You should get exactly one row, one column, one numeric value.

---

## 4. Signal verification via `az rest`

After `bash .agents/skills/healthmodel-deploy/scripts/apply.sh` finishes, **read entity state** to confirm each signal returns a real `healthState` — not `Unknown`.

### 4.1 Read health state from entities

```bash
HM='/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CloudHealth/healthModels/<name>'
API='2026-01-01-preview'

az rest --method get \
  --url "https://management.azure.com$HM/entities?api-version=$API" \
  -o json \
  | jq '[.value[]? | {
        entity: .name,
        state: .properties.healthState,
        signals: [.properties.signalGroups // {} | to_entries[].value.signals[]? | {
          name, state: .status.healthState, value: .status.value
        }]
      } | select(.signals | length > 0)]'
```

> **Note:** The `2026-01-01-preview` API does not expose a per-signal `/execute` POST endpoint. Signals auto-evaluate on their `refreshInterval` cadence. Read health state via `GET .../entities`.

### 4.2 Interpret `healthState`

| State | Meaning | Action |
|---|---|---|
| `Healthy` | Signal evaluated, threshold not crossed | Nothing — leave it. |
| `Degraded` | `degradedRule` crossed, `unhealthyRule` not | Early warning surfaced as expected. |
| `Unhealthy` | `unhealthyRule` crossed | Investigate the underlying resource. |
| `Unknown` | Signal could not evaluate | **Almost always a signal-definition bug — see 4.3.** |

### 4.3 Troubleshooting `Unknown`

```bash
az rest --method get \
  --url "https://management.azure.com$HM/entities?api-version=$API" -o json \
  | jq '[.value[]? | .properties.signalGroups // {} | to_entries[].value.signals[]?
         | select(.status.healthState == "Unknown")
         | {name, state: .status.healthState}]'
```

Common reasons (`stateReason` field) and fixes:

| `stateReason` substring | Cause | Fix |
|---|---|---|
| `No data` / `NoData` | Query returned empty | PromQL: append `or vector(0)`. KQL: add the `union (print 0)` guard. ARM metric: pick a metric you can confirm exists with `az monitor metrics list`. |
| `AuthorizationFailed` / `403` | Managed identity missing RBAC | Section 4.4. |
| `Invalid metric` / `MetricNotFound` | Wrong `metricName` or `metricNamespace`, or a dimension smuggled in | Re-check Section 1.1 output. |
| `Invalid aggregation` | `aggregationType` not in `supportedAggregationTypes` | Use one of the supported aggregations from `list-definitions`. |
| `Timeout` / `QueryTimeout` | PromQL too expensive (high cardinality) | Pin labels, drop dimensions, increase the rate window. |

### 4.4 Check RBAC on the signal-execution identity

```bash
IDENTITY_PRINCIPAL_ID="$(az rest --method get \
  --url "https://management.azure.com$HM/authenticationSettings?api-version=$API" \
  -o json \
  | jq -r '.value[0].properties.managedIdentityName' \
  | xargs -I {} az identity show --ids {} -o json \
  | jq -r '.principalId')"

az role assignment list --assignee "$IDENTITY_PRINCIPAL_ID" --all -o json \
  | jq '[.[] | {role: .roleDefinitionName, scope}]'
```

Required role assignments:

| Signal kind | Required role | Scope |
|---|---|---|
| `AzureResourceMetric` | `Monitoring Reader` | The monitored resource (or its RG / subscription) |
| `LogAnalyticsQuery` | `Log Analytics Reader` (or `Monitoring Reader`) | The Log Analytics workspace |
| `PrometheusMetricsQuery` | `Monitoring Data Reader` | The Azure Monitor Workspace |

If the role is missing, signals stay `Unknown` even though the query itself is correct.

---

## 5. Threshold design

### 5.1 Pick direction first, threshold second

| Metric semantics | Direction | Operator | Example |
|---|---|---|---|
| Availability, success rate, uptime | `lower-is-worse` | `LessThan` | `99` is worse than `100` |
| Errors, throttling, latency, queue depth, CPU% | `higher-is-worse` | `GreaterThan` | `10` is worse than `1` |
| Active connections (for "is the producer alive?") | `lower-is-worse` | `LessThan` | `0` means nobody connected |

If you can't decide direction without picking a number first, you've chosen the wrong metric.

### 5.2 Degraded = early warning, Unhealthy = action required

For `higher-is-worse`: `degraded.threshold < unhealthy.threshold`.
For `lower-is-worse`: `degraded.threshold > unhealthy.threshold`.

Reverse, and the signal will skip `Degraded` and flip straight to `Unhealthy` (or vice versa). The validator does **not** catch this — it's a logic error.

### 5.3 Derive thresholds from baseline data

Use Section 1.2 to collect 1 hour (or ideally 24 hours / 7 days) of samples. Pick from this distribution rather than guessing:

| Direction | Degraded suggestion | Unhealthy suggestion |
|---|---|---|
| `higher-is-worse` | P95 of baseline | 2× P95, or a hard service limit (e.g., RU quota = 100) |
| `lower-is-worse` | Floor of normal range (e.g., observed min) | SLO target (e.g., availability 99 if your SLO is 99.5) |

For a brand-new workload with no baseline, start with public service limits (RU quota, request throttling tier, SKU max) and tag the design `"_review": "needs baseline data"`.

### 5.4 Integers vs decimals

The deploy-phase Bicep validator (`signal-arm.bicep` / `signal-prom.bicep` / `signal-log.bicep` against `Microsoft.CloudHealth@2026-01-01-preview`) treats `threshold` as a number — but the convention enforced by `validate.sh` is **integer literals only**. Sub-integer values cause real problems:

- A threshold of `0.5` for `Percentage5xx` is ambiguous when the underlying metric is integer-counted.
- JSON serializers occasionally emit `"0.5"` (string) which Bicep then rejects with `BCP036`.

How to express sub-integer intent with integers:

| You wanted | Use instead |
|---|---|
| Availability degraded at `99.9%` | `dataUnit: Percent`, threshold `99` (one nine less). If you need 99.9, pick a finer-grained KQL signal that reports "down minutes" and threshold on a count. |
| `0.5%` 5xx rate | Multiply by 100 in the query so the unit is `basis points` (use a custom KQL/PromQL query), threshold `50`. |
| Latency `1.5s` | Switch unit to `MilliSeconds`, threshold `1500`. |

When in doubt: change the **unit / scale of the query**, not the threshold precision.

### 5.5 Validate the rule pair before saving

```bash
jq -e '
  .evaluationRules as $r |
  if $r.degradedRule.operator == "GreaterThan" then
    $r.degradedRule.threshold < $r.unhealthyRule.threshold
  elif $r.degradedRule.operator == "LessThan" then
    $r.degradedRule.threshold > $r.unhealthyRule.threshold
  else false end
' .healthmodel/03-design/signals/sd-my-signal.json \
  || echo "FAIL — degraded does not trip before unhealthy"
```

Run on every signal-definition file before handing off to deploy.

---

## 6. Fallback workflow for any unknown resource type

1. `az monitor metrics list-definitions --resource "$RID"` and classify with the `jq` golden-signal filter (Section 1.3).
2. Pick at most one metric per category that matters to users; reject metrics whose only useful form needs a dimension you can't express in the schema (Section 1.5).
3. Sample 1 h of data per metric (Section 1.2); set thresholds from the baseline (Section 5.3).
4. Set entity `impact` to `Limited` and add `"_review": "needs human review — auto-derived"` to each signal file.
5. After deploy, run the verification block in Section 4 and convert anything still `Unknown` into a fix-or-remove decision.

## 7. Error handling — quick lookup

| Symptom | Likely cause | Fix |
|---|---|---|
| `BCP036` on `threshold` | String not int | Remove quotes — `100` not `"100"`. |
| `BCP037` on a signal field | Field belongs to a different `signalKind` | Re-read the design skill's flat-properties contract; remove the misplaced field. |
| Signal always `Unknown` | No-data on empty result set | Append `or vector(0)` (PromQL) or `union (print 0)` (KQL); for ARM metric, confirm metric exists with `az monitor metrics list`. |
| Signal stuck at one state regardless of resource health | Direction reversed | Swap `GreaterThan` / `LessThan` so it matches `higher-is-worse` / `lower-is-worse`. |
| Signal flaps `Unknown` ↔ `Healthy` | `aggregationType` not supported by metric | Use a value from `supportedAggregationTypes`. |
| `AuthorizationFailed` in `stateReason` | Identity missing RBAC | Grant the role from Section 4.4 on the right scope. |
| Threshold validator complains degraded ≥ unhealthy | Pair logic inverted | Re-check Section 5.2. |

## References

- [./references/metrics.md](./references/metrics.md) — copy-pasteable discovery & verification recipes.
- [./references/promql-cheatsheet.md](./references/promql-cheatsheet.md) — Kubernetes PromQL patterns for AKS health signals.
- [./references/promql-validation.md](./references/promql-validation.md) — PromQL development, testing, and validation workflow using `az rest`.
- `healthmodel-design/SKILL.md` — the consumer of this skill; defines the sparse signal-definition JSON shape.
- `healthmodel-deploy/scripts/validate.sh` — offline Bicep schema check for every signal file.
- `healthmodel-deploy/scripts/validate-promql.sh` — live PromQL validation against an AMW.
