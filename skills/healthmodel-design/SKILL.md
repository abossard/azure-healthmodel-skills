---
name: healthmodel-design
description: "Design health model entities, signal definitions, and relationships from the architecture graph. Emits complete design files and generates a modular Bicep project for deployment. WHEN: 'design entities and signals', 'propose health thresholds', 'create health model spec', 'generate signal definitions', 'generate bicep for health model'. DO NOT USE FOR: discovery (use healthmodel-discovery), deployment to Azure (use healthmodel-deploy), modifying live health models directly."
---

# Health Model Design

Transform the architecture graph into concrete signal definitions, entities, and relationships. Generates a modular Bicep project under `.healthmodel/05-bicep/` for deployment. Supports two modes: **opinionated** (SLO-driven, production-grade) and **exploration** (all available metrics for learning).

## What "complete design" means

Each design file contains the **full `properties` body** for the resource — all required fields populated with either user-derived values (opinionated mode) or permissive defaults (exploration mode). This is required because Bicep/ARM treats declared resources as desired state — unspecified properties may be removed or defaulted by the resource provider.

The agent fills in all required defaults during design. The user only needs to provide the values they care about (via the interview in discovery). Everything else gets sensible defaults.

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
3. ⛔ MANDATORY: Each design file contains **all required fields** for the resource type. The agent fills in sensible defaults for any field the user didn't explicitly configure. This ensures clean Bicep deployment.
4. ⛔ MANDATORY: Signal-definition `signalKind`-specific fields are **flat under `properties`** (NOT nested under `azureResourceMetric`/`prometheusMetricsQuery`/etc. sub-objects). Bicep enforces this; `healthmodel-deploy/scripts/validate.sh` will catch the mistake.
5. ⛔ MANDATORY: Thresholds are integers (`100`), not strings (`"100"`).
6. ⛔ MANDATORY: PromQL queries end with `or vector(0)` to avoid `Unknown` on no-data.
7. ⛔ MANDATORY: Each entity has at most one parent (tree, not DAG). Leaf entities carry signal groups; branch entities have no signals (health rolls up).
8. ⛔ MANDATORY: For unknown resource types, omit `evaluationRules` and tag the design file with `"_review": "needs human review"` (the underscore key won't be sent because bicep would reject it — strip before deploy, OR populate evaluationRules to the best guess and document the rationale).
9. ⛔ MANDATORY: Stop after Step 7 and present the design for user approval before handing off to deploy.
10. ⛔ MANDATORY: When the architecture graph contains `Microsoft.ContainerService/managedClusters` **and** `Microsoft.Monitor/accounts` (AMW), propose PromQL signals for AKS workloads using the [PromQL cheatsheet](../healthmodel-signal-catalog/references/promql-cheatsheet.md). AKS ARM metrics alone (`FailedPodCounts`, `cluster_autoscaler_*`) are event-based and unreliable — PromQL with `or vector(0)` is the correct approach.
11. ⛔ MANDATORY: If a PromQL signal cannot be validated against the live AMW, mark it `(broken)` in `displayName` — e.g., `"displayName": "AKS Pod Restarts (broken)"`. A broken signal still deploys (shows `Unknown`) but is visibly flagged. See [promql-validation.md](../healthmodel-signal-catalog/references/promql-validation.md).
12. ⛔ MANDATORY: Do NOT create a custom root entity (e.g., `e-root`). The health model resource itself IS the root entity — ARM automatically creates an implicit entity named after the model (e.g., `hm-myapp`). Top-level entities connect to this implicit root via relationships with `parentEntityName` set to the model name.
13. ⛔ MANDATORY: Children under a `Limited` or `Suppressed` parent entity MUST use `Standard` impact. Impact controls upward propagation and is set on the parent grouping entity only, not on its children.
14. ⛔ MANDATORY: Read the `mode` field from `.healthmodel/01-discovery.json` before starting. If `mode == "exploration"`, follow the exploration-mode path in Step 0. Default: `opinionated`.
15. ⛔ MANDATORY: Generated Bicep under `.healthmodel/05-bicep/` must include a `// GENERATED FILE — edit .healthmodel/03-design instead` header. Regenerate before every deploy.

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

### Step 0: Mode Check

Read the `mode` field from `.healthmodel/01-discovery.json`:

```bash
MODE=$(jq -r '.mode // "opinionated"' .healthmodel/01-discovery.json)
echo "Health model mode: $MODE"
```

- If `mode == "opinionated"`: proceed with the standard SLO-driven flow (Steps 1-7).
- If `mode == "exploration"`: follow the exploration-mode path below, then skip to Step 2.

#### Exploration Mode — All-Metrics Signal Generation

When exploration mode is selected, discover ALL usable metrics for each resource and create signals with permissive thresholds. This gives the user a learning-oriented health model that shows every available metric.

**For each resource in `.healthmodel/resources.json`:**

1. **Discover metrics**:
```bash
DATA_METRICS=".healthmodel/data/discovery/metric-definitions"
mkdir -p "$DATA_METRICS"

jq -r '.[].id' .healthmodel/resources.json | while read -r rid; do
  NAME="$(echo "$rid" | rev | cut -d/ -f1 | rev)"
  az monitor metrics list-definitions --resource "$rid" -o json 2>&1 > "$DATA_METRICS/$NAME.json"
done
```

2. **Filter to usable metrics** — a metric is usable when ALL of these are true:
   - `dataUnit` is a numeric type (Percent, Count, Bytes, BytesPerSecond, CountPerSecond, MilliSeconds, Seconds, etc.) — NOT `Unspecified`
   - At least one supported `aggregationType` exists (Average, Total, Maximum, Minimum, Count)
   - No mandatory dimension filter is required (metric works without `dimensionFilter`)
   - The metric has a non-empty `name.value`

3. **Cap at ~10 signals per resource** — if more than 10 usable metrics exist, prioritize:
   - Availability/health metrics first
   - Latency/response time metrics
   - Error/failure metrics
   - Throughput/request metrics
   - Saturation (CPU, memory, connections)
   - Everything else alphabetically until the cap

4. **Create signals with permissive thresholds** — thresholds so wide they effectively never trigger:
   - For `Percent` metrics: `degradedRule.threshold = 0`, `unhealthyRule.threshold = 0` (operator `LessThan`) — always Healthy unless metric hits 0%
   - For `Count`/rate metrics (errors/failures): `degradedRule.threshold = 999999`, `unhealthyRule.threshold = 9999999` (operator `GreaterThan`) — always Healthy
   - For `MilliSeconds`/latency metrics: `degradedRule.threshold = 999999`, `unhealthyRule.threshold = 9999999` (operator `GreaterThan`)
   - Display name includes the metric name for discoverability: `"displayName": "EXPLORE: <metricName> (<dataUnit>)"`

5. **Group entities by resource type** (not user journey):
   - One entity per resource (not per golden-signal category)
   - Entity display name: `"EXPLORE: <resourceName> (<resourceType short>)"`
   - Impact: all `Standard` (no business-context differentiation in exploration mode)

6. **Still honor discovery constraints**:
   - Respect `excludedResources` from `01-discovery.json`
   - Use the same managed identity / auth settings
   - Same scope (subscription, resource groups, location)

After generating exploration signals, skip Step 1 (SLO-driven signal generation) and proceed to Step 2 (Entities — with exploration-mode entities).

### Step 1: Signal Definitions (opinionated mode)

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

### Step 1b: AKS PromQL Signal Generation

When the graph contains AKS clusters with an AMW, generate PromQL signals **in addition to** any ARM metric signals. AKS ARM metrics are event-based (they emit data only when the condition is active, e.g., `FailedPodCounts` only appears when pods fail) — PromQL with `or vector(0)` is the reliable alternative.

**Detection**:

```bash
# Check for AKS + AMW in the architecture graph
AKS_COUNT=$(jq '[.nodes[] | select(.type == "Microsoft.ContainerService/managedClusters")] | length' .healthmodel/02-graph.json)
AMW_COUNT=$(jq '[.nodes[] | select(.type == "Microsoft.Monitor/accounts")] | length' .healthmodel/02-graph.json)

if [ "$AKS_COUNT" -gt 0 ] && [ "$AMW_COUNT" -gt 0 ]; then
  echo "AKS + AMW detected — generating PromQL signals"
fi
```

**Signal selection** — pick from the [PromQL cheatsheet](../healthmodel-signal-catalog/references/promql-cheatsheet.md) based on the brief's golden-signal priority (§3 SLOs, §7 golden signal ranking):

| Priority | Cheatsheet section | Minimum signals |
|---|---|---|
| Always include | §2 Pod Health | Pod Restarts, CrashLoopBackOff |
| High (availability/errors) | §2 Pod Health | OOMKilled, Pending Pods |
| High (saturation) | §3 CPU & Memory | CPU %, Memory % |
| Medium | §5 Deployment & Scaling | Min Replicas, HPA Ceiling |
| Medium (if Istio) | §6 Networking | 5xx Rate, P99 Latency |
| Low | §4 Node Pressure | Pods on NotReady Nodes |
| Low (if cert-manager) | §7 Cert Manager | Days to Expiry |

For each AKS cluster in the graph:
1. Identify the Kubernetes namespace(s) from `01-discovery.json` or ask the user.
2. Hard-code the namespace into each query (no variable substitution).
3. Reference the AMW resource ID from the graph's `Microsoft.Monitor/accounts` node.

**Entity wiring** — AKS PromQL signals use the `azureMonitorWorkspace` signal group:

```json
{
  "displayName": "swedencentral-001 — AKS Workloads",
  "impact": "Standard",
  "icon": {"iconName": "AzureKubernetesService"},
  "signalGroups": {
    "azureMonitorWorkspace": {
      "authenticationSetting": "id-healthmodel-myapp",
      "azureMonitorWorkspaceResourceId": "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Monitor/accounts/<amw>",
      "signals": [
        {
          "name": "sa-aks-restarts",
          "signalDefinitionName": "sd-aks-restarts",
          "signalKind": "PrometheusMetricsQuery",
          "refreshInterval": "PT1M"
        }
      ]
    }
  }
}
```

**Validation** — after writing signal files, test them against the live AMW:

```bash
AMW='/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Monitor/accounts/<amw>'
bash .agents/skills/healthmodel-deploy/scripts/validate-promql.sh "$AMW"
```

If any query fails, the script marks it `(broken)` in `displayName`. Fix or accept and move on — a broken signal still deploys but shows `Unknown` until fixed. See [promql-validation.md](../healthmodel-signal-catalog/references/promql-validation.md) for troubleshooting.

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

Impact — set on the **parent grouping entity only**, not on its children:

| Impact | Meaning | Where to set |
|---|---|---|
| `Standard` | Failure escalates to parent | Default for all leaf/child entities |
| `Limited` | Visible degradation, doesn't turn parent red | Parent grouping entity only |
| `Suppressed` | Informational, doesn't escalate | Parent grouping entity only |

⛔ **Impact propagation rule**: Children under a `Limited` or `Suppressed` parent MUST use `Standard` impact. The parent's impact level already controls whether the group's health propagates upward. Setting `Suppressed` or `Limited` on children is redundant and loses granularity between siblings within the group.

Correct pattern:
```
Root (Standard)
├── RAG Pipeline (Standard)        ← group escalates to root
│   ├── Backend (Standard)         ← failures escalate within group
│   └── AI Inference (Standard)
├── Observability (Suppressed)     ← group health doesn't reach root
│   ├── App Telemetry (Standard)   ← Standard: visible within group
│   └── Log Analytics (Standard)   ← Standard: visible within group
└── Platform (Limited)             ← group visible but won't turn root red
    └── Container Platform (Standard) ← Standard within group
```

Layout: `canvasPosition` — compute using the **cumulative-width algorithm** (derived from the azure-search-openai-demo pattern):

#### Canvas Layout Algorithm

The layout positions entities on a 2D canvas for the Azure portal health model visualization. The algorithm is recursive and handles arbitrary tree depth.

**Constants:**
- `leafSpacing = 250` — horizontal distance between leaf/sibling entities
- `depthSpacing = 200` — vertical distance between tree levels

**Rules:**

1. **Y-position**: `y = depth × depthSpacing` where depth 0 = root (implicit, not rendered), depth 1 = top-level groups, depth 2 = leaves, etc. This scales to any tree depth.

2. **Subtree width**: For each entity, compute its subtree width recursively:
   - Leaf entity (no children): `subtreeWidth = 1`
   - Branch entity: `subtreeWidth = max(1, sum of children's subtreeWidths)`
   - Empty/conditional entities (no signals, no children): **omit entirely** — do not create the entity or its relationship

3. **X-position**: For each entity at a given depth, its x-position is the cumulative sum of all prior siblings' subtree widths × leafSpacing:
   ```
   x(entity[i]) = sum(subtreeWidth(entity[j]) for j < i) × leafSpacing
   ```
   Where entities are ordered by: Standard impact first, then Limited, then Suppressed; within the same impact level, tie-break by order in the brief, then lexicographic by name.

4. **Group x-offset**: A branch entity's x-position is the x of its first child (leftmost child alignment).

**Example** — given this hierarchy:
```
Root (implicit)
├── RAG Pipeline (Standard, 3 leaves)  → x=0, y=200
│   ├── Backend (Standard)             → x=0, y=400
│   ├── AI Inference (Standard)        → x=250, y=400
│   └── Knowledge Search (Standard)    → x=500, y=400
├── Platform (Limited, 1 leaf)         → x=750, y=200
│   └── Container Platform (Standard)  → x=750, y=400
└── Observability (Suppressed, 2 leaves) → x=1000, y=200
    ├── App Telemetry (Standard)       → x=1000, y=400
    └── Log Analytics (Standard)       → x=1250, y=400
```

**Computation**:
- RAG Pipeline subtreeWidth=3, Platform subtreeWidth=1, Observability subtreeWidth=2
- RAG Pipeline x = 0 (first group)
- Platform x = 3 × 250 = 750
- Observability x = (3+1) × 250 = 1000

### Step 3: Relationships

One file per parent→child link in `.healthmodel/03-design/relationships/`:

Top-level entities connect to the health model's implicit root entity (the model name):

```json
{
  "parentEntityName": "hm-myapp",
  "childEntityName": "e-rag-pipeline"
}
```

Child-to-child relationships reference entity filenames:

```json
{
  "parentEntityName": "e-rag-pipeline",
  "childEntityName": "e-cosmos-sc1"
}
```

`parentEntityName` and `childEntityName` reference entity filenames (not display names, not UUIDs). For top-level entities, `parentEntityName` is the health model name — the implicit root entity created by ARM. Do NOT create a separate root entity.

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

# Every relationship's parent/child matches an entity file (or the model root)
MODEL_NAME=$(jq -r '.modelName // empty' .healthmodel/01-discovery.json 2>/dev/null || echo "")
jq -r '.parentEntityName, .childEntityName' .healthmodel/03-design/relationships/*.json | sort -u \
  | while read -r e; do
      [ "$e" = "$MODEL_NAME" ] && continue  # implicit root entity = model name
      [ -f ".healthmodel/03-design/entities/$e.json" ] \
        || echo "MISSING entity: $e (not a design entity and not the model root '$MODEL_NAME')"
    done
```

### Step 6: Generate Bicep Project

Generate a modular Bicep project under `.healthmodel/05-bicep/` from the design JSON files. This Bicep is the **deployable output** — the deploy skill uses `az deployment group create` with it.

#### File Structure

```
.healthmodel/05-bicep/
├── main.bicep                  # Root: params, health model resource, module calls
├── modules/
│   ├── identity.bicep          # UAMI + role assignments (if identity mode = create)
│   ├── auth.bicep              # Auth settings — one resource per auth JSON file
│   ├── signals.bicep           # Signal definitions — one resource per signal JSON file
│   ├── entities.bicep          # Entities — one resource per entity JSON file
│   └── relationships.bicep     # Relationships — one resource per relationship JSON file
```

#### Generation Rules

1. **Header**: Every generated `.bicep` file starts with:
   ```bicep
   // GENERATED FILE — edit .healthmodel/03-design instead
   // Regenerated by healthmodel-design skill. Do not edit directly.
   ```

2. **Individual resource declarations**: Each JSON file in `03-design/` becomes ONE resource declaration with a literal `loadJsonContent()` path. **Do NOT use loops with variable paths** — Bicep requires compile-time string literals for `loadJsonContent()`.

   Example for a signal definition:
   ```bicep
   resource sdCosmosAvail 'Microsoft.CloudHealth/healthModels/signalDefinitions@2026-01-01-preview' = {
     parent: healthModel
     name: 'sd-cosmos-avail'
     properties: loadJsonContent('../../03-design/signals/sd-cosmos-avail.json')
   }
   ```

3. **Symbolic names**: Derive Bicep symbolic names from filenames by replacing hyphens with underscores and prefixing with the resource kind:
   - `signals/sd-cosmos-avail.json` → `signal_sd_cosmos_avail`
   - `entities/e-rag-pipeline.json` → `entity_e_rag_pipeline`
   - `relationships/r-root-rag.json` → `rel_r_root_rag`
   - `auth/id-healthmodel-myapp.json` → `auth_id_healthmodel_myapp`

4. **Deterministic ordering**: Within each module, sort resource declarations alphabetically by filename. This ensures stable diffs across regenerations.

5. **main.bicep structure**:
   ```bicep
   // GENERATED FILE — edit .healthmodel/03-design instead
   targetScope = 'resourceGroup'

   @description('Name of the health model')
   param healthModelName string

   @description('Azure region for the health model')
   param location string

   @description('Identity mode: existing = attach provided UAMI, create = create UAMI + role assignments')
   @allowed(['existing', 'create'])
   param identityMode string = 'existing'

   @description('Full resource ID of existing UAMI (required when identityMode=existing)')
   param existingUamiId string = ''

   @description('Name for new UAMI (required when identityMode=create)')
   param createUamiName string = ''

   resource healthModel 'Microsoft.CloudHealth/healthModels@2026-01-01-preview' = {
     name: healthModelName
     location: location
     identity: identityMode == 'existing' ? {
       type: 'SystemAssigned,UserAssigned'
       userAssignedIdentities: {
         '${existingUamiId}': {}
       }
     } : {
       type: 'SystemAssigned'
     }
     properties: {}
   }

   // Module imports for auth, signals, entities, relationships
   module authSettings './modules/auth.bicep' = {
     name: 'auth-settings'
     params: { healthModelName: healthModel.name }
   }
   module signalDefinitions './modules/signals.bicep' = {
     name: 'signal-definitions'
     params: { healthModelName: healthModel.name, authId: authSettings.outputs.id }
   }
   module entities './modules/entities.bicep' = {
     name: 'entities'
     params: { healthModelName: healthModel.name, signalsId: signalDefinitions.outputs.id }
   }
   module relationships './modules/relationships.bicep' = {
     name: 'relationships'
     params: { healthModelName: healthModel.name, entitiesId: entities.outputs.id }
   }
   ```

   > **Note**: If `identityMode == 'create'`, add the identity module before auth and include UAMI creation + role assignments.

6. **Module structure** — each module file follows this pattern:
   ```bicep
   // GENERATED FILE — edit .healthmodel/03-design instead
   param healthModelName string

   resource healthModel 'Microsoft.CloudHealth/healthModels@2026-01-01-preview' existing = {
     name: healthModelName
   }

   // One resource per JSON file (enumerate all files in the corresponding 03-design subdirectory):
   resource signal_sd_cosmos_avail 'Microsoft.CloudHealth/healthModels/signalDefinitions@2026-01-01-preview' = {
     parent: healthModel
     name: 'sd-cosmos-avail'
     properties: loadJsonContent('../../03-design/signals/sd-cosmos-avail.json')
   }
   // ... repeat for each JSON file
   ```

7. **Granular updates** (AC9): Because each JSON file maps to exactly one Bicep resource declaration via `loadJsonContent()`, changing a single JSON file affects only that one resource in the next `az deployment group what-if` diff. The user edits JSON → regenerates Bicep → runs what-if → sees only the changed resource.

8. **Regeneration**: The Bicep project should be regenerated before every deploy (the deploy skill does this). To regenerate: enumerate all JSON files in `03-design/`, generate the corresponding Bicep declarations, write to `05-bicep/`.

#### Generation Process

For each subdirectory in `.healthmodel/03-design/` (`auth/`, `signals/`, `entities/`, `relationships/`):
1. List all `.json` files, sorted alphabetically
2. For each file, generate a resource declaration with:
   - Symbolic name derived from filename
   - `parent: healthModel`
   - `name: '<filename-without-extension>'`
   - `properties: loadJsonContent('../../03-design/<subdir>/<filename>')`
3. Write the module file to `.healthmodel/05-bicep/modules/<kind>.bicep`

Generate `main.bicep` with parameters derived from `01-discovery.json` (model name, location, identity config).

### Step 7: Present the design

Show:
- Entity tree (text, with impact)
- Signal binding count per entity, total signal-definition count
- Any signal where thresholds were guessed (flag for human review)
- **Brief traceability**: for each SLO target in `.healthmodel/00-brief.md` §3, name the signal(s) that cover it. For each Top Concern (§4), name the entity/signal that surfaces it. Call out any SLO or concern with no covering signal.
- Reminder: every field listed in a design file will be asserted on apply. Anything omitted will be left to live state.

Ask: *"Ready to deploy? Or adjust thresholds first?"*

## Next Step

Announce: *"Design complete. Design files written under `.healthmodel/03-design/`. Bicep project generated at `.healthmodel/05-bicep/`. Load `healthmodel-integrate` to integrate into existing IaC, or load `healthmodel-deploy` to validate and deploy standalone."* Then stop — do not auto-proceed.

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
| AKS cluster found but no AMW in graph | Can't write PromQL signals without an Azure Monitor Workspace | Ask user if managed Prometheus is enabled; if not, fall back to AKS ARM metrics (with caveats about event-based metrics) |
| PromQL signal marked `(broken)` | Query failed validation against live AMW | See [promql-validation.md](../healthmodel-signal-catalog/references/promql-validation.md) — check metric availability, fix query, re-validate |
