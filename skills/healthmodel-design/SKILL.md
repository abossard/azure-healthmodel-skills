---
name: healthmodel-design
description: "Design health model entities, signal definitions, and relationships from the architecture graph. Emits SPARSE design files (only fields the skill manages) so the deploy phase can merge cleanly with portal edits. WHEN: 'design entities and signals', 'propose health thresholds', 'create health model spec', 'generate signal definitions'. DO NOT USE FOR: discovery (use healthmodel-discovery), deployment to Azure (use healthmodel-deploy), modifying live health models directly."
---

# Health Model Design

Transform the architecture graph into concrete signal definitions, entities, and relationships ready for deployment. Produces sparse JSON files only — no Azure calls, no extension required.

## What "sparse design" means

Each design file contains **only the `properties` body** for the resource, and within that body, **only the fields this skill is responsible for**. Anything not present is left to live state (for an existing model) or defaults (for new resources).

This is the contract the deploy skill relies on: `live * design = PUT body`. If you don't want the deploy phase to ever touch a field, **omit it** from the design file. If you want it asserted, **include it**.

File layout under `.healthmodel/03-design/`:

```
auth/<short-name>.json            → properties body for an authenticationSettings resource
signals/<short-name>.json         → properties body for a signalDefinitions resource
entities/<short-name>.json        → properties body for an entities resource
relationships/<short-name>.json   → properties body for a relationships resource
```

The filename (without `.json`) is the resource's ARM name. Use deterministic short names (e.g., `sd-cosmos-avail`, `e-aks-sc1`, `r-root-cosmos`) — no need for UUIDs. ARM accepts lowercase letters, digits, and hyphens.

## Rules

1. ⛔ MANDATORY: `.healthmodel/02-graph.json` and `.healthmodel/01-discovery.json` must exist and contain real Azure resource IDs (from a live `az resource list`, not placeholders). If they contain placeholder or empty data, **stop** and direct the user to run discovery + architecture first.
2. ⛔ MANDATORY: Design files contain **only the `properties` body** — no top-level `name`, `type`, or wrapper. The deploy phase derives URLs from the filename + kind directory.
3. ⛔ MANDATORY: Each design file contains **only fields the skill is asserting**. Don't pad with defaults you don't intend to enforce.
4. ⛔ MANDATORY: Signal-definition `signalKind`-specific fields are **flat under `properties`** (NOT nested under `azureResourceMetric`/`prometheusMetricsQuery`/etc. sub-objects). Bicep enforces this; `healthmodel-deploy/scripts/validate.sh` will catch the mistake.
5. ⛔ MANDATORY: Thresholds are integers (`100`), not strings (`"100"`).
6. ⛔ MANDATORY: PromQL queries end with `or vector(0)` to avoid `Unknown` on no-data.
7. ⛔ MANDATORY: Each entity has at most one parent (tree, not DAG). Leaf entities carry signal groups; branch entities have no signals (health rolls up).
8. ⛔ MANDATORY: For unknown resource types, omit `evaluationRules` and tag the design file with `"_review": "needs human review"` (the underscore key won't be sent because bicep would reject it — strip before deploy, OR populate evaluationRules to the best guess and document the rationale).
9. ⛔ MANDATORY: Stop after Step 6 and present the design for user approval before handing off to deploy.

## Prerequisites

```bash
test -f .healthmodel/02-graph.json && test -f .healthmodel/01-discovery.json \
  || { echo "STOP: run healthmodel-architecture first"; exit 1; }

# graph must have real Azure resource IDs, not placeholders
jq -e '[.nodes[] | select(.id | test("^/subscriptions/[0-9a-f]{8}-"))] | length > 0' .healthmodel/02-graph.json >/dev/null 2>&1 \
  || { echo "STOP: 02-graph.json has no real Azure resource IDs — run healthmodel-discovery + architecture against a live subscription"; exit 1; }

test -f .healthmodel/00-brief.md \
  || echo "WARN: .healthmodel/00-brief.md not found — proceeding with defaults from brief §10"
command -v jq >/dev/null
```

The signal catalog (`healthmodel-signal-catalog/SKILL.md` + `references/metrics.md`) is reference data this skill reads — it has `disable-model-invocation: true` and is not loaded as a separate skill.

## Steps

### Step 1: Signal Definitions

Read `.healthmodel/00-brief.md` before writing any signal file:

- **§3 SLO / SLA Targets** — derive thresholds directly. If SLO is "P95 < 500ms", set `degradedRule.threshold = 500` and `unhealthyRule.threshold = 1000` (~2× degraded). For availability SLOs (e.g., 99.95%), set degraded slightly above the SLO floor and unhealthy at the floor.
- **§5 What to Observe priorities** — `H` (high) = mandatory signal coverage for that resource; `M` = include standard signals; `L` = include only if a flat ARM metric exists (no PromQL/KQL plumbing).
- **§6 Alert Philosophy → Sensitivity**:
  - `quiet` → widen the gap between degraded/unhealthy (e.g., 2× and 5×); higher thresholds overall; drop `L`-priority signals.
  - `balanced` → use signal-catalog recommendations as-is.
  - `noisy` → tighten thresholds (e.g., degraded at SLO floor, unhealthy at 1.5×); include `L`-priority signals.
- **§4 Top Concerns** — concern #1 gets the most signals + tightest thresholds. "Silent failures" concern → add explicit `or vector(0)` / `coalesce` guards and lower thresholds.

If the brief is missing or a section is blank, fall back to brief §9 defaults.

One file per signal definition in `.healthmodel/03-design/signals/`. **Flat properties** — the kind-specific fields sit directly under `properties`.

**AzureResourceMetric** (e.g., Cosmos ServiceAvailability):

```json
{
  "displayName": "Cosmos Availability",
  "signalKind": "AzureResourceMetric",
  "dataUnit": "Percent",
  "refreshInterval": "PT1M",
  "metricNamespace": "microsoft.documentdb/databaseaccounts",
  "metricName": "ServiceAvailability",
  "aggregationType": "Average",
  "timeGrain": "PT1M",
  "evaluationRules": {
    "degradedRule":  {"operator": "LessThan", "threshold": 100},
    "unhealthyRule": {"operator": "LessThan", "threshold": 95}
  }
}
```

**PrometheusMetricsQuery** (the AMW resource ID lives on the *entity's* signal group, not here):

```json
{
  "displayName": "AKS Pod Restarts",
  "signalKind": "PrometheusMetricsQuery",
  "dataUnit": "Count",
  "refreshInterval": "PT1M",
  "queryText": "sum(rate(kube_pod_container_status_restarts_total[5m])) or vector(0)",
  "timeGrain": "PT1M",
  "evaluationRules": {
    "degradedRule":  {"operator": "GreaterThan", "threshold": 1},
    "unhealthyRule": {"operator": "GreaterThan", "threshold": 5}
  }
}
```

**LogAnalyticsQuery** (workspace ID lives on the entity's signal group):

```json
{
  "displayName": "App Errors",
  "signalKind": "LogAnalyticsQuery",
  "dataUnit": "Count",
  "refreshInterval": "PT5M",
  "queryText": "AppExceptions | summarize Count=count()",
  "valueColumnName": "Count",
  "timeGrain": "PT5M",
  "evaluationRules": {
    "degradedRule":  {"operator": "GreaterThan", "threshold": 10},
    "unhealthyRule": {"operator": "GreaterThan", "threshold": 100}
  }
}
```

### Step 2: Entities

One file per entity in `.healthmodel/03-design/entities/`. Leaf entities have `signalGroups`; branch entities (Failures, Latency) omit it.

```json
{
  "displayName": "swedencentral-001 — Cosmos",
  "impact": "Standard",
  "icon": {"iconName": "AzureCosmosDB"},
  "canvasPosition": {"x": 275, "y": 0},
  "signalGroups": {
    "azureResource": {
      "authenticationSetting": "id-healthmodel-myapp",
      "azureResourceId": "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.DocumentDB/databaseAccounts/cosmos-myapp",
      "signals": [
        {
          "name": "sa-cosmos-avail",
          "signalDefinitionName": "sd-cosmos-avail",
          "signalKind": "AzureResourceMetric",
          "refreshInterval": "PT1M"
        }
      ]
    }
  }
}
```

`signalGroups` keys (the discriminator picks the right query path):

| Key | Use for |
|---|---|
| `azureResource` | ARM metrics signals (`AzureResourceMetric`). Needs `azureResourceId`. |
| `azureMonitorWorkspace` | Prometheus signals. Needs `azureMonitorWorkspaceResourceId`. |
| `azureLogAnalytics` | Log Analytics KQL signals. Needs `logAnalyticsWorkspaceResourceId`. |
| `dependencies` | Roll-up from child entities only — no external query. |

Inside each `signals[]` entry: `name` is the per-entity binding name (NOT `signalAssignmentName`), and `signalDefinitionName` references the signal-definition's filename. Both required. `signalKind` must match the definition's kind.

Icon hints (truncated — see catalog reference for the full set): `SystemComponent` (root), `AzureKubernetesService`, `AzureCosmosDB`, `AzureFrontDoor`, `AppService`, `StorageAccount`, `AzureKeyVault`, `Resource` (generic).

Impact: `Standard` (failure escalates to parent), `Limited` (visible, doesn't escalate), `Suppressed` (telemetry/monitoring).

Layout: `canvasPosition` grid — `x = depth × 275`, `y = sibling-index × 200`. Root entity uses `x: 0, y: 0`.

### Step 3: Relationships

One file per parent→child link in `.healthmodel/03-design/relationships/`:

```json
{
  "parentEntityName": "e-root",
  "childEntityName": "e-cosmos-sc1"
}
```

`parentEntityName` and `childEntityName` reference entity filenames (not display names, not UUIDs).

### Step 4: Authentication Setting

One file per managed identity in `.healthmodel/03-design/auth/`:

```json
{
  "authenticationKind": "ManagedIdentity",
  "displayName": "HealthModel reader",
  "managedIdentityName": "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-healthmodel-myapp"
}
```

The identity needs `Monitoring Reader` on every RG containing monitored resources (and `Monitoring Data Reader` on the AMW for Prometheus queries).

### Step 5: Local validation (offline schema check)

Run the deploy skill's validator without touching Azure — it uses `az bicep build` to verify every file against the `Microsoft.CloudHealth@2026-01-01-preview` schema:

```bash
bash .agents/skills/healthmodel-deploy/scripts/validate.sh .healthmodel/03-design
```

Fix anything reported as `BCP035` (missing required), `BCP036` (wrong type — usually a quoted threshold), or `BCP037` (disallowed property — usually a field on the wrong `signalKind`) before continuing.

Also sanity-check cross-references:

```bash
# Every signal binding's signalDefinitionName matches a signal file
jq -r '.. | objects | .signalDefinitionName // empty' .healthmodel/03-design/entities/*.json | sort -u \
  | while read -r ref; do
      [ -f ".healthmodel/03-design/signals/$ref.json" ] \
        || echo "MISSING signal definition: $ref"
    done

# Every relationship's parent/child matches an entity file
jq -r '.parentEntityName, .childEntityName' .healthmodel/03-design/relationships/*.json | sort -u \
  | while read -r e; do
      [ -f ".healthmodel/03-design/entities/$e.json" ] \
        || echo "MISSING entity: $e"
    done
```

### Step 6: Present the design

Show:
- Entity tree (text, with impact)
- Signal binding count per entity, total signal-definition count
- Any signal where thresholds were guessed (flag for human review)
- **Brief traceability**: for each SLO target in `.healthmodel/00-brief.md` §3, name the signal(s) that cover it. For each Top Concern (§4), name the entity/signal that surfaces it. Call out any SLO or concern with no covering signal.
- Reminder: every field listed in a design file will be asserted on apply. Anything omitted will be left to live state.

Ask: *"Ready to deploy? Or adjust thresholds first?"*

## Next Step

Announce: *"Design complete. Sparse files written under `.healthmodel/03-design/`. Load `healthmodel-deploy` and start with `bash .agents/skills/healthmodel-deploy/scripts/validate.sh`."* Then stop — do not auto-proceed.

## Error Handling

| Error | Cause | Fix |
|---|---|---|
| `02-graph.json` missing | Architecture phase skipped | Run **healthmodel-architecture** first |
| `validate.sh` reports BCP037 on `queryText` for AzureResourceMetric | Nesting bug — `queryText` is for Prometheus/LogAnalytics, not ARM metrics | Replace with flat `metricNamespace` + `metricName` + `aggregationType` |
| `validate.sh` reports BCP037 on `azureResourceMetric`/`prometheusMetricsQuery` sub-object | Old nested shape | Flatten the kind-specific fields directly under `properties` |
| `validate.sh` reports BCP036 on `threshold` | Quoted number | Use `"threshold": 100`, not `"threshold": "100"` |
| Signal binding references a missing definition | Typo / file rename | Cross-check filename equals `signalDefinitionName` in entities |
| Threshold ordering invalid | `degraded` ≥ `unhealthy` on `GreaterThan` (or reverse on `LessThan`) | Re-check direction; degraded is the early warning, unhealthy is action-required |
| Unknown resource type | Not in signal catalog | Run `az monitor metrics list-definitions --resource <id>` to find metrics; document threshold rationale in a comment |
| Cyclic relationship | Entity reused as parent and child | One parent per entity — promote one to root or move to a side group |
| Signal always `Unknown` for event-based ARM metrics | Metric only emits data when the condition is active (e.g., `cluster_autoscaler_unschedulable_pods_count`) | Switch to PromQL with `or vector(0)` or KQL with `coalesce`; see signal-catalog § 1.6 |
