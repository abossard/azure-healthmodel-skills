# Signal Discovery Recipes

Copy-pasteable scripts that complement [../SKILL.md](../SKILL.md). All recipes assume:

- `az` CLI logged in to the right subscription (`az account show`).
- `jq` installed.
- Bash on macOS (Darwin) or Linux.
- API version `2026-01-01-preview` for any health-model `az rest` call.

Replace placeholder identifiers (`<sub>`, `<rg>`, `<name>`, `$RID`, `$HM`) before running.

---

## Recipe 1 — Inventory metrics for any resource

```bash
RID='/subscriptions/<sub>/resourceGroups/<rg>/providers/<provider>/<type>/<name>'

az monitor metrics list-definitions --resource "$RID" -o json \
  | jq '[.[] | {
        name: .name.value,
        namespace: .metricNamespace,
        unit,
        primaryAgg: .primaryAggregationType,
        aggs: .supportedAggregationTypes,
        dims: [.dimensions[]?.value]
      }]'
```

Maps directly onto the four schema fields:

| `jq` field | Signal-definition field |
|---|---|
| `.name` | `metricName` |
| `.namespace` | `metricNamespace` |
| `.unit` | `dataUnit` |
| one of `.aggs` | `aggregationType` |

---

## Recipe 2 — Highlight golden-signal candidates

```bash
az monitor metrics list-definitions --resource "$RID" -o json | jq '
  def classify(n; u):
    if   (n | test("avail"; "i"))                                       then "availability"
    elif (n | test("latency|duration|responsetime|e2e"; "i"))           then "latency"
    elif (n | test("error|fail|5xx|4xx|exception|deadletter"; "i"))     then "errors"
    elif (n | test("throttle|429|busy"; "i"))                           then "saturation"
    elif (n | test("cpu|memory|connections|load|ru|queue|backlog"; "i"))then "saturation"
    elif (u == "Percent")                                               then "ratio"
    else "other" end;
  [.[] | {
     golden: classify(.name.value; .unit),
     name: .name.value, unit, primaryAgg: .primaryAggregationType
   }] | sort_by(.golden, .name) | group_by(.golden)
       | map({(.[0].golden): map({name, unit, primaryAgg})}) | add'
```

Aim for 2–4 final signals per entity (one per relevant golden category).

---

## Recipe 3 — Sample 1 h of baseline data

```bash
START="$(date -u -v-1H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
        || date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%SZ')"

az monitor metrics list \
  --resource "$RID" \
  --metric "ServiceAvailability" \
  --aggregation Average \
  --interval PT5M \
  --start-time "$START" \
  -o json \
  | jq '[.value[0].timeseries[0].data[] | select(.average != null) | .average]
        | { n: length, min: min, max: max, avg: (add/length) }'
```

Use the resulting `min` / `max` / `avg` to seed thresholds (see SKILL.md §5.3).

For a `higher-is-worse` metric, pull P95 instead of avg:

```bash
... | jq '[.value[0].timeseries[0].data[] | select(.total != null) | .total]
        | sort | .[((length*95)/100 | floor)]'
```

---

## Recipe 4 — Check supported aggregations before deploying

Bicep does not validate that the chosen `aggregationType` is supported by the metric — Azure silently returns `null` at runtime. Verify upfront:

```bash
METRIC="ServiceAvailability"

az monitor metrics list-definitions --resource "$RID" -o json \
  | jq --arg m "$METRIC" '.[] | select(.name.value == $m) | .supportedAggregationTypes'
```

Pick the result that matches the math:

| Query shape | Choose |
|---|---|
| Counter rate via `rate(...)` / `total over window` | `Total` |
| Percent / gauge averaged over time | `Average` |
| Worst-case sample | `Maximum` (`higher-is-worse`) or `Minimum` (`lower-is-worse`) |

---

## Recipe 5 — Probe a PromQL expression against an AMW

```bash
AMW='/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Monitor/accounts/<amw>'

EP="$(az monitor account show --ids "$AMW" -o json \
       | jq -r '.metrics.prometheusQueryEndpoint')"

TOKEN="$(az account get-access-token --resource "$EP" -o json | jq -r '.accessToken')"

QUERY='sum(rate(kube_pod_container_status_restarts_total{namespace="prod"}[5m])) or vector(0)'

curl -sG "$EP/api/v1/query" \
  --data-urlencode "query=$QUERY" \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.data.result'
```

A non-empty `result` array confirms the query parses and the AMW has data. The `or vector(0)` tail guarantees you'll never get an empty result — perfect for health signals.

---

## Recipe 6 — Probe a KQL expression against a Log Analytics workspace

```bash
WS='/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<ws>'
WS_ID="$(az monitor log-analytics workspace show --ids "$WS" -o json | jq -r '.customerId')"

az monitor log-analytics query --workspace "$WS_ID" \
  --analytics-query '
    AppExceptions
    | where TimeGenerated > ago(5m)
    | summarize Count = count()
    | union (print Count = 0)
    | summarize Count = sum(Count)
  ' \
  -o json | jq '.tables[0].rows'
```

Expected output: exactly one row, one column, one numeric value. That value is what the signal evaluator compares against `evaluationRules`.

---

## Recipe 7 — Read health state from deployed entities

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

Signals auto-evaluate on their `refreshInterval` cadence. Use the response to drive the verification loop: anything `Unknown` is a bug in the signal definition or in the RBAC of the auth identity.

---

## Recipe 8 — Filter to broken signals only

```bash
az rest --method get \
  --url "https://management.azure.com$HM/entities?api-version=$API" -o json \
  | jq '[.value[]? | {entity: .name} + (.properties.signalGroups // {} | to_entries[].value.signals[]?
         | select(.status.healthState == "Unknown")
         | {signal: .name, state: .status.healthState})]'
```

Pipe the output of this command into your remediation plan. Cross-reference each `reason` with the troubleshooting table in SKILL.md §4.3.

---

## Recipe 9 — Verify the signal-execution identity has the right roles

```bash
IDENTITY="$(az rest --method get \
  --url "https://management.azure.com$HM/authenticationSettings?api-version=$API" \
  -o json | jq -r '.value[0].properties.managedIdentityName')"

PRINCIPAL_ID="$(az identity show --ids "$IDENTITY" -o json | jq -r '.principalId')"

az role assignment list --assignee "$PRINCIPAL_ID" --all -o json \
  | jq '[.[] | {role: .roleDefinitionName, scope}]'
```

Match against the requirements:

| Signal kind | Role | Scope |
|---|---|---|
| `AzureResourceMetric` | `Monitoring Reader` | Monitored resource (or higher) |
| `LogAnalyticsQuery` | `Log Analytics Reader` (or `Monitoring Reader`) | Log Analytics workspace |
| `PrometheusMetricsQuery` | `Monitoring Data Reader` | Azure Monitor Workspace |

---

## Recipe 10 — Local sanity check on a draft signal-definition file

Before invoking `healthmodel-deploy/scripts/validate.sh`:

```bash
FILE=.healthmodel/03-design/signals/sd-my-signal.json

# 1. JSON parses
jq empty "$FILE" || { echo "invalid JSON"; exit 1; }

# 2. Thresholds are integers
jq -e '
  .evaluationRules.degradedRule.threshold  | type == "number" and . == (. | floor)
' "$FILE" >/dev/null || echo "FAIL — degraded threshold is not an integer"

jq -e '
  .evaluationRules.unhealthyRule.threshold | type == "number" and . == (. | floor)
' "$FILE" >/dev/null || echo "FAIL — unhealthy threshold is not an integer"

# 3. Degraded trips before unhealthy
jq -e '
  .evaluationRules as $r |
  if   $r.degradedRule.operator == "GreaterThan" then $r.degradedRule.threshold <  $r.unhealthyRule.threshold
  elif $r.degradedRule.operator == "LessThan"    then $r.degradedRule.threshold >  $r.unhealthyRule.threshold
  else false end
' "$FILE" >/dev/null || echo "FAIL — degraded does not trip before unhealthy"

# 4. PromQL queries end with `or vector(0)`
jq -e '
  (.signalKind != "PrometheusMetricsQuery") or (.queryText | test("or vector\\(0\\)\\s*$"))
' "$FILE" >/dev/null || echo "FAIL — PromQL query missing `or vector(0)`"

# 5. KQL queries declare valueColumnName
jq -e '
  (.signalKind != "LogAnalyticsQuery") or (.valueColumnName != null and .valueColumnName != "")
' "$FILE" >/dev/null || echo "FAIL — LogAnalyticsQuery missing valueColumnName"
```

Anything that prints `FAIL —` blocks the design from moving to deploy.

---

## Cross-references

- [../SKILL.md §1](../SKILL.md) — full discovery narrative.
- `healthmodel-design/SKILL.md` Step 1 — exact JSON shape of a signal definition.
- `healthmodel-deploy/scripts/validate.sh` — Bicep schema validator (the deploy gate).
