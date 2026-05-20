---
name: healthmodel-discovery
description: "Discover Azure resources and interview user to prepare health model inputs. WHEN: 'discover resources for health model', 'scan my Azure', 'what should I monitor', 'interview for health model'. DO NOT USE FOR: deploying health models (use healthmodel-deploy), general resource inventory without health model intent, cost or compliance audits."
---

# Health Model Discovery

Guide the user through sequential steps of resource discovery and architecture interview, ensuring inputs are prepared for health model creation. Uses only `az resource list` + `jq`.

## Rules

1. ⛔ MANDATORY: Confirm Azure subscription explicitly with the user before exporting resources.
2. ⛔ MANDATORY: Refuse to proceed if resources span multiple subscriptions — pick one.
3. ⛔ MANDATORY: Refuse if no compute resources are found in any RG.
4. ⛔ MANDATORY: Save all answers to `.healthmodel/01-discovery.json` before handing off.
5. ⛔ MANDATORY: Use `jq` for JSON parsing — never `grep` or `sed` on JSON.
6. ⛔ MANDATORY: Do not proceed past discovery until the user has reviewed and confirmed `.healthmodel/00-brief.md`.
7. ⛔ MANDATORY: Every `az` command that queries Azure must persist its full output (including errors) to `.healthmodel/data/<phase>/<category>/`. Use `2>&1 | tee` for commands where you also need stdout, or `> file 2>&1` for background collection. File names should include the resource name for easy lookup. Timestamps are optional but recommended for baselines. The `.healthmodel/data/` directory is gitignored — never commit collected data.

## Prerequisites

```bash
# Azure CLI authenticated, jq present
az account show -o json 2>/dev/null | jq '{subscriptionId: .id, name: .name}'
command -v jq >/dev/null && echo "jq: ok"
```

## Steps

### Step 1: Interview

Ask the user interactively. Offer "skip / use defaults" for non-essentials.

Required:
1. **Subscription**: Confirm `az account show` or ask for ID
2. **Resource groups**: Comma-separated list, or "all"
3. **Application name**: Used as model name prefix (`hm-<name>`)
4. **Location**: Region for the health model resource (default: first RG's location)

Architecture:
5. **Compute pattern**: `AKS-microservices` / `Container-Apps` / `App-Service` / `Functions` / `mixed`
6. **Multi-stamp?**: `single-region` / `active-active` / `active-passive`
7. **Golden signal priority** (rank 1-4): availability, latency, error-rate, saturation
8. **Data tier**: `Cosmos` / `SQL` / `PostgreSQL` / `Storage` / `Redis` / `none`
9. **Async messaging**: `Service-Bus` / `Event-Hubs` / `Storage-Queues` / `none`
10. **Ingress**: `Front-Door` / `App-Gateway` / `direct-LB` / `Istio` / `none`
11. **Observability stack**: `AMW+Grafana` / `Log-Analytics-only` / `App-Insights` / `mix`
12. **AI services**: `Azure-OpenAI` / `AI-Search` / `AI-Foundry` / `Document-Intelligence` / `Content-Safety` / `none`
13. **AI on request path?**: `yes-critical` (inference is in the hot path) / `yes-background` (batch/async enrichment) / `no`
14. **Content safety monitoring**: `built-in-filters` / `custom-safety-pipeline` / `none`

### Step 2: Resource Export

```bash
bash .agents/skills/healthmodel-discovery/scripts/export-resources.sh "$SUB" rg-1 rg-2  # or: $(echo "$RG_LIST")
```

### Step 3: Resource Inventory

```bash
bash .agents/skills/healthmodel-discovery/scripts/inventory.sh
```

Writes `.healthmodel/resources.json` and prints type counts + stamp grouping.

### Step 3b: Resource Graph Topology (optional, complements Step 2)

If `az graph query` is available, use Resource Graph to discover cross-resource relationships and topology that `az resource list` may not fully enumerate:

```bash
az extension add --name resource-graph 2>/dev/null

DATA_GRAPH=".healthmodel/data/discovery/resource-graph"
mkdir -p "$DATA_GRAPH"

# Discover all resource types in the monitored RGs
az graph query -q "
  Resources
  | where resourceGroup in~ ($(jq -r '[.resourceGroups[] | \"\x27\"+.+\"\x27\"] | join(\",\")' .healthmodel/01-discovery.json))
  | summarize count() by type
  | order by count_ desc
" --first 200 -o json 2>&1 | tee "$DATA_GRAPH/resource-types.json"

# Discover resource details: kind, SKU, endpoints, networking
az graph query -q "
  Resources
  | where resourceGroup in~ ($(jq -r '[.resourceGroups[] | \"\x27\"+.+\"\x27\"] | join(\",\")' .healthmodel/01-discovery.json))
  | project name, type, kind, location, resourceGroup, sku=sku.name, endpoint=properties.endpoint, subnet=properties.virtualNetworkSubnetId
" --first 500 -o json 2>&1 | tee "$DATA_GRAPH/resource-details.json"

# Check Resource Health for all discovered resources
az graph query -q "
  HealthResources
  | where type =~ 'microsoft.resourcehealth/availabilitystatuses'
  | where resourceGroup in~ ($(jq -r '[.resourceGroups[] | \"\x27\"+.+\"\x27\"] | join(\",\")' .healthmodel/01-discovery.json))
  | project resourceId=id, state=properties.availabilityState, reason=properties.reasonType
  | where state != 'Available'
" --first 100 -o json 2>&1 | tee "$DATA_GRAPH/resource-health.json"
```

Resource Graph results are advisory — they complement, not replace, the `resources.json` from Step 3.

### Step 4: User Brief — fill the human context

The infra shape alone can't tell you SLOs, user journeys, or what the user actually cares about. Generate a brief and have the user fill it in.

```bash
mkdir -p .healthmodel
cp .agents/skills/healthmodel-discovery/templates/health-model-brief.md .healthmodel/00-brief.md

# Pre-fill {{APP_NAME}} from interview
APP_NAME=$(jq -r '.appName // "your-app"' .healthmodel/01-discovery.json 2>/dev/null || echo "your-app")
sed -i.bak "s/{{APP_NAME}}/$APP_NAME/g" .healthmodel/00-brief.md && rm .healthmodel/00-brief.md.bak
```

Pre-fill `## 1. Azure Scope` from the interview answers and current `az account`:

```bash
SUB_ID=$(jq -r '.subscription' .healthmodel/01-discovery.json)
SUB_NAME=$(az account show --query name -o tsv)
LOCATION=$(jq -r '.location' .healthmodel/01-discovery.json)
RGS=$(jq -r '.resourceGroups[]' .healthmodel/01-discovery.json)
```

Fill in subscription ID, name, location, and generate the Resource Groups table rows from the interview answers. If a UAMI named `id-healthmodel-*` was found during resource export, pre-fill the managed identity field.

Then pre-fill `## 6. What to Observe` from `.healthmodel/resources.json` — one row per discovered resource. For each resource, dynamically discover golden-signal candidates:

```bash
DATA_METRICS=".healthmodel/data/discovery/metric-definitions"
mkdir -p "$DATA_METRICS"

jq -r '.[].id' .healthmodel/resources.json | while read -r rid; do
  NAME="$(echo "$rid" | rev | cut -d/ -f1 | rev)"
  TYPE="$(echo "$rid" | grep -oP 'providers/\K[^/]+/[^/]+')"
  az monitor metrics list-definitions --resource "$rid" -o json 2>&1 > "$DATA_METRICS/$NAME.json"
  SIGNALS=$(jq -r '[.[].name.value] | join(", ")' "$DATA_METRICS/$NAME.json" 2>/dev/null || echo "(discovery failed)")
  echo "| \`$TYPE\` ($NAME) | $SIGNALS |"
done
```

Then apply the golden-signal classifier from the signal catalog (Recipe 2) to each resource to highlight the most relevant metrics. The classifier groups metrics into availability, latency, errors, saturation, usage, safety, etc. — pick 2-4 per entity.

Build the rows with `jq` from `.healthmodel/resources.json`, then append into the brief between the table header and the trailing `---`.

**CHECKPOINT** — stop and tell the user:

> Brief template written to `.healthmodel/00-brief.md`. Please review and fill in sections 1-5 and 7-9, then tell me when ready to continue.

Do not run Step 5 until the user confirms.

### Step 5: Relationship Discovery

```bash
bash .agents/skills/healthmodel-discovery/scripts/relationships.sh "$SUB"
```

Prints AKS / Cosmos / ingress / AMW anchors and writes `.healthmodel/data/relationships/rbac/all-assignments.json` (scoped to monitored RGs only).

> **Note**: `.healthmodel/data/` contains potentially sensitive data (RBAC assignments, full resource IDs, diagnostic settings). A `.gitignore` excludes this directory from version control. Regenerate with `export-resources.sh` and `relationships.sh`.

### Step 5b: Diagnostic Settings Coverage Check

Check which resources have diagnostic settings configured. Missing diagnostics means KQL/Log Analytics signals will fail (ARM metric signals are unaffected).

```bash
echo "== Diagnostic Settings Coverage =="
DATA_DIAG=".healthmodel/data/discovery/diagnostic-settings"
mkdir -p "$DATA_DIAG"

jq -r '.[].id' .healthmodel/resources.json | while read -r rid; do
  NAME="$(echo "$rid" | rev | cut -d/ -f1 | rev)"
  az monitor diagnostic-settings list --resource "$rid" -o json 2>&1 > "$DATA_DIAG/$NAME.json"
  COUNT=$(jq '(.value // .) | length' "$DATA_DIAG/$NAME.json" 2>/dev/null)
  if [ "$COUNT" = "0" ] || [ "$COUNT" = "" ]; then
    echo "  ⚠ NO diagnostics: $NAME → $DATA_DIAG/$NAME.json"
  else
    echo "  ✓ $NAME ($COUNT settings) → $DATA_DIAG/$NAME.json"
  fi
done
```

Resources without diagnostic settings can still use `AzureResourceMetric` signal kind, but `LogAnalyticsQuery` signals require diagnostic log routing to a workspace.

### Step 6: Validate & Present

Present to the user:
- Resource type inventory table
- Detected stamps/regions
- Key resources (compute, data, ingress)
- Gaps (e.g., AKS but no AMW → PromQL signals will fail)

Ask: "Does this look right? Any corrections?"

### Step 7: Save

`.healthmodel/01-discovery.json`:
```json
{
  "subscription": "...",
  "resourceGroups": ["rg-1", "rg-2"],
  "appName": "myapp",
  "location": "swedencentral",
  "compute": "AKS-microservices",
  "multiStamp": "active-active",
  "goldenSignals": ["availability", "latency", "error-rate", "saturation"],
  "dataTier": "Cosmos",
  "messaging": "none",
  "ingress": "Front-Door",
  "observability": "AMW+Grafana",
  "aiServices": "Azure-OpenAI",
  "aiOnRequestPath": "yes-critical",
  "contentSafety": "built-in-filters",
  "stamps": ["swedencentral-001", "swedencentral-002"],
  "resources": { }
}
```

## Next Step

Announce: *"Discovery complete. `.healthmodel/00-brief.md` (user-confirmed), `.healthmodel/01-discovery.json`, and `.healthmodel/resources.json` are written. Load `healthmodel-architecture` to continue."* Then stop — do not auto-proceed.

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| `az account show` fails | Not logged in | `az login` |
| Resources span multiple subscriptions | User mixed scopes | Refuse; pick one subscription |
| No compute resources found | Empty RGs | Stop and ask user for correct RG list |
| `jq: command not found` | jq missing | `brew install jq` or apt equivalent |
| Subscription mismatch | `az account` differs from user's stated subscription | `az account set --subscription <id>` |
