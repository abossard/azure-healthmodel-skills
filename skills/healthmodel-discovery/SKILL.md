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

### Step 2: Resource Export

```bash
bash .agents/skills/healthmodel-discovery/scripts/export-resources.sh "$SUB" rg-1 rg-2  # or: $(echo "$RG_LIST")
```

### Step 3: Resource Inventory

```bash
bash .agents/skills/healthmodel-discovery/scripts/inventory.sh
```

Writes `.healthmodel/resources.json` and prints type counts + stamp grouping.

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

Then pre-fill `## 6. What to Observe` from `.healthmodel/resources.json` — one row per discovered resource. Suggested-signal hints by type (use the signal catalog as the source of truth, this is a starting point):

| Resource type | Suggested signals |
|---|---|
| `Microsoft.ContainerService/managedClusters` | node Ready, pod restarts, API server latency |
| `Microsoft.DocumentDB/databaseAccounts` | availability, P99 latency, 429 rate |
| `Microsoft.Web/sites` | HTTP 5xx, response time, CPU |
| `Microsoft.Storage/storageAccounts` | availability, throttling, latency |
| `Microsoft.ServiceBus/namespaces` | active messages, throttled requests, DLQ depth |
| `Microsoft.KeyVault/vaults` | availability, throttled requests |
| `Microsoft.Cdn/profiles` (Front Door) | origin health, 5xx rate, latency |
| `Microsoft.Network/applicationGateways` | backend health, failed requests, response time |
| _other_ | leave column blank — design phase will fill from catalog |

Build the rows with `jq` from `.healthmodel/resources.json`, then append into the brief between the table header and the trailing `---`.

**CHECKPOINT** — stop and tell the user:

> Brief template written to `.healthmodel/00-brief.md`. Please review and fill in sections 1-5 and 7-9, then tell me when ready to continue.

Do not run Step 5 until the user confirms.

### Step 5: Relationship Discovery

```bash
bash .agents/skills/healthmodel-discovery/scripts/relationships.sh "$SUB"
```

Prints AKS / Cosmos / ingress / AMW anchors and writes `.healthmodel/raw/rbac.json` (scoped to monitored RGs only).

> **Note**: `.healthmodel/raw/` contains potentially sensitive data (RBAC assignments, full resource IDs). A `.gitignore` excludes this directory from version control. Regenerate with `export-resources.sh` and `relationships.sh`.

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
