---
name: healthmodel-discovery
description: "Discover Azure resources and interview user to prepare health model inputs. WHEN: 'discover resources for health model', 'scan my Azure', 'what should I monitor', 'interview for health model'. DO NOT USE FOR: deploying health models (use healthmodel-deploy), general resource inventory without health model intent, cost or compliance audits."
---

# Health Model Discovery

Guide the user through sequential steps of resource discovery and interactive interview using the `ask_user` tool to collect structured answers. The brief (`00-brief.md`) is auto-generated from interview answers — the user never edits it manually. Uses only `az resource list` + `jq`.

## Rules

1. ⛔ MANDATORY: Confirm Azure subscription explicitly with the user before exporting resources.
2. ⛔ MANDATORY: Refuse to proceed if resources span multiple subscriptions — pick one.
3. ⛔ MANDATORY: Refuse if no compute resources are found in any RG.
4. ⛔ MANDATORY: Save all answers to `.healthmodel/01-discovery.json` before handing off.
5. ⛔ MANDATORY: Use `jq` for JSON parsing — never `grep` or `sed` on JSON.
6. ⛔ MANDATORY: Do not proceed past discovery until the user has confirmed the objectives summary (Step 4d).
7. ⛔ MANDATORY: Every `az` command that queries Azure must persist its full output (including errors) to `.healthmodel/data/<phase>/<category>/`. Use `2>&1 | tee` for commands where you also need stdout, or `> file 2>&1` for background collection. File names should include the resource name for easy lookup. Timestamps are optional but recommended for baselines. The `.healthmodel/data/` directory is gitignored — never commit collected data.
8. ⛔ MANDATORY: Use the `ask_user` copilot agent tool for ALL interview questions. Never direct the user to manually edit a markdown file for interview answers.
9. ⛔ MANDATORY: If `.healthmodel/00-brief.md` already exists from a previous run, ask the user (via `ask_user`) whether to use it or re-interview. Do not silently overwrite.

## Prerequisites

```bash
# Azure CLI authenticated, jq present
az account show -o json 2>/dev/null | jq '{subscriptionId: .id, name: .name}'
command -v jq >/dev/null && echo "jq: ok"
```

## Steps

### Step 1: Azure Scope

Confirm the Azure subscription with the user. Run `az account show` and present the result. If the user needs a different subscription, run `az account set --subscription <id>`.

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

If `az graph query` is available, use Resource Graph to discover cross-resource relationships:

```bash
az extension add --name resource-graph 2>/dev/null
# (same Resource Graph queries as before — discover types, details, and health)
```

### Step 4: Interactive Interview

Use the `ask_user` tool to conduct a structured interview across multiple forms. Each form collects a category of inputs. The user can decline any form (defaults apply).

#### Backward compatibility check

Before starting the interview, check for an existing brief:

```bash
if [ -f .healthmodel/00-brief.md ]; then
  echo "Existing brief found"
fi
```

If `.healthmodel/00-brief.md` exists, present the user with a choice via `ask_user`:

```json
{
  "message": "An existing health model brief was found at `.healthmodel/00-brief.md`. Would you like to use it or start a fresh interview?",
  "requestedSchema": {
    "properties": {
      "briefAction": {
        "type": "string",
        "title": "Existing brief action",
        "enum": ["use-existing", "re-interview"],
        "enumNames": ["Use the existing brief as-is", "Start a fresh interview (overwrites the brief)"],
        "default": "use-existing"
      }
    },
    "required": ["briefAction"]
  }
}
```

If the user chooses `use-existing`, skip to Step 5 (Relationship Discovery). Otherwise, continue with the interview forms below.

#### Step 4a: Form 1 — App Basics & Mode Selection

Use `ask_user` with this schema:

```json
{
  "message": "Let's set up your health model. First, tell me about your application and what kind of health model you want.\n\n**Opinionated mode**: I'll ask about your SLOs, user journeys, and concerns to build a focused, production-grade health model that monitors what matters most.\n\n**Exploration mode**: I'll discover ALL available metrics for your resources and create a learning-oriented health model. Great for understanding what signals are available before committing to specific monitoring.",
  "requestedSchema": {
    "properties": {
      "appName": {
        "type": "string",
        "title": "Application name",
        "description": "Used as the health model name prefix (e.g., 'myapp' → 'hm-myapp')"
      },
      "resourceGroups": {
        "type": "string",
        "title": "Resource groups",
        "description": "Comma-separated list of resource groups to monitor, or 'all'"
      },
      "location": {
        "type": "string",
        "title": "Azure region",
        "description": "Region for the health model resource (e.g., 'swedencentral'). Default: first RG's location."
      },
      "mode": {
        "type": "string",
        "title": "Health model mode",
        "enum": ["opinionated", "exploration"],
        "enumNames": [
          "Opinionated — focused, SLO-driven, production-grade",
          "Exploration — discover all available metrics for learning"
        ],
        "default": "opinionated"
      }
    },
    "required": ["appName", "resourceGroups", "mode"]
  }
}
```

#### Step 4b: Form 2 — Architecture & Priorities (opinionated mode only)

Skip this form if `mode == "exploration"`.

```json
{
  "message": "Now let's understand your architecture and monitoring priorities.",
  "requestedSchema": {
    "properties": {
      "compute": {
        "type": "string",
        "title": "Compute pattern",
        "enum": ["AKS-microservices", "Container-Apps", "App-Service", "Functions", "mixed"],
        "default": "AKS-microservices"
      },
      "multiStamp": {
        "type": "string",
        "title": "Deployment topology",
        "enum": ["single-region", "active-active", "active-passive"],
        "default": "single-region"
      },
      "goldenSignals": {
        "type": "array",
        "title": "Golden signal priority (order matters — first = highest priority)",
        "items": {
          "type": "string",
          "enum": ["availability", "latency", "error-rate", "saturation"]
        },
        "default": ["availability", "latency", "error-rate", "saturation"],
        "minItems": 1,
        "maxItems": 4
      },
      "dataTier": {
        "type": "string",
        "title": "Primary data tier",
        "enum": ["Cosmos", "SQL", "PostgreSQL", "Storage", "Redis", "none"],
        "default": "Cosmos"
      },
      "messaging": {
        "type": "string",
        "title": "Async messaging",
        "enum": ["Service-Bus", "Event-Hubs", "Storage-Queues", "none"],
        "default": "none"
      },
      "ingress": {
        "type": "string",
        "title": "Ingress / load balancer",
        "enum": ["Front-Door", "App-Gateway", "direct-LB", "Istio", "none"],
        "default": "Front-Door"
      },
      "observability": {
        "type": "string",
        "title": "Observability stack",
        "enum": ["AMW+Grafana", "Log-Analytics-only", "App-Insights", "mix"],
        "default": "AMW+Grafana"
      },
      "aiServices": {
        "type": "string",
        "title": "AI services in use",
        "enum": ["Azure-OpenAI", "AI-Search", "AI-Foundry", "Document-Intelligence", "Content-Safety", "none"],
        "default": "none"
      },
      "aiOnRequestPath": {
        "type": "string",
        "title": "AI on the request path?",
        "enum": ["yes-critical", "yes-background", "no"],
        "enumNames": [
          "Yes — inference is in the hot path (latency-critical)",
          "Yes — batch/async enrichment (background)",
          "No AI services"
        ],
        "default": "no"
      },
      "contentSafety": {
        "type": "string",
        "title": "Content safety monitoring",
        "enum": ["built-in-filters", "custom-safety-pipeline", "none"],
        "default": "none"
      },
      "criticalJourneys": {
        "type": "string",
        "title": "Critical user journeys",
        "description": "Describe 1-3 critical user journeys (e.g., 'User searches products → adds to cart → checks out'). One per line."
      },
      "sloTargets": {
        "type": "string",
        "title": "SLO / SLA targets",
        "description": "e.g., 'P95 latency < 500ms, availability > 99.95%, error rate < 0.1%'"
      },
      "topConcerns": {
        "type": "string",
        "title": "Top concerns (rank by importance)",
        "description": "e.g., 'Silent failures in payment processing, Database connection pool exhaustion, AI model latency spikes'"
      }
    },
    "required": ["compute"]
  }
}
```

#### Step 4c: Form 3 — Alert Philosophy & Stamps (opinionated mode only)

Skip this form if `mode == "exploration"`.

```json
{
  "message": "Almost done — let's set your alerting philosophy and any stamp-specific behavior.",
  "requestedSchema": {
    "properties": {
      "sensitivity": {
        "type": "string",
        "title": "Alert sensitivity",
        "description": "How sensitive should health signals be?",
        "enum": ["quiet", "balanced", "noisy"],
        "enumNames": [
          "Quiet — wide thresholds, fewer alerts, only escalate real issues",
          "Balanced — use signal-catalog recommendations as-is",
          "Noisy — tight thresholds, aggressive early warning"
        ],
        "default": "balanced"
      },
      "stamps": {
        "type": "string",
        "title": "Stamp names",
        "description": "If multi-stamp: comma-separated stamp identifiers (e.g., 'swedencentral-001, westeurope-001'). Leave empty for single-region."
      },
      "stampFailBehavior": {
        "type": "string",
        "title": "One stamp goes down — what happens at root?",
        "enum": ["unhealthy", "degraded"],
        "enumNames": [
          "Unhealthy — one stamp down = root goes red",
          "Degraded — one stamp down = root goes yellow (other stamps serve traffic)"
        ],
        "default": "degraded"
      },
      "excludedResources": {
        "type": "string",
        "title": "Resources to exclude from monitoring",
        "description": "Comma-separated resource names or types to skip (e.g., 'test-storage, Microsoft.Insights/components')"
      }
    },
    "required": ["sensitivity"]
  }
}
```

#### Step 4d: Objectives Summary — confirm before proceeding

After collecting all interview answers, present the user's main objectives back to them as a summary. Use `ask_user` for confirmation:

```json
{
  "message": "Here's a summary of your health model objectives. Please confirm or request changes.\n\n**Application**: {{appName}} ({{mode}} mode)\n**Scope**: {{resourceGroups}} in {{location}}\n**Mode**: {{modeDescription}}\n\n{{#if opinionated}}\n**Critical journeys**: {{criticalJourneys}}\n**SLO targets**: {{sloTargets}}\n**Top concerns**: {{topConcerns}}\n**Alert sensitivity**: {{sensitivity}}\n**Stamp behavior**: {{stampBehavior}}\n{{/if}}\n\n{{#if exploration}}\n**Approach**: I'll discover all available metrics for each resource and create signals with permissive thresholds. You'll see every metric Azure exposes — useful for learning what's available before narrowing down.\n{{/if}}",
  "requestedSchema": {
    "properties": {
      "confirmed": {
        "type": "boolean",
        "title": "Objectives look correct?",
        "default": true
      },
      "corrections": {
        "type": "string",
        "title": "Any corrections or additions?",
        "description": "Leave empty if everything looks good."
      }
    },
    "required": ["confirmed"]
  }
}
```

Replace the `{{...}}` placeholders with actual values from the interview answers before presenting.

If the user sets `confirmed: false` or provides corrections, incorporate the changes and re-present the summary until confirmed.

**CHECKPOINT** — do not proceed until the user confirms the objectives summary.

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

### Step 5: Auto-generate Brief

Generate `.healthmodel/00-brief.md` automatically from the confirmed interview answers. The user never edits this file manually — it is a derived artifact.

```bash
mkdir -p .healthmodel
```

Use the template from `.agents/skills/healthmodel-discovery/templates/health-model-brief.md` as the structure, but fill ALL sections programmatically from the interview answers:

- **§1 Azure Scope**: subscription, resource groups, location, managed identity from discovery
- **§2 Critical User Journeys**: from interview `criticalJourneys` (opinionated) or "Exploration mode — all metrics" (exploration)
- **§3 SLO / SLA Targets**: from interview `sloTargets` (opinionated) or "N/A — exploration mode uses permissive thresholds" (exploration)
- **§4 Top Concerns**: from interview `topConcerns` (opinionated) or "Discover available metrics" (exploration)
- **§5 What to Observe**: auto-generated from `.healthmodel/resources.json` — one row per resource with discovered metrics:

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

Apply the golden-signal classifier from the signal catalog (Recipe 2) to highlight the most relevant metrics per resource.

- **§6 Alert Philosophy**: from interview `sensitivity` (opinionated) or "permissive — exploration mode" (exploration)
- **§7 Stamp & Regional Behavior**: from interview `stamps`, `stampFailBehavior`, `multiStamp`
- **§8 Environment & Exclusions**: from interview `excludedResources`
- **§9 Defaults**: filled with standard defaults
- **§10 Mode**: `opinionated` or `exploration` — this field drives design behavior

Write the file:

```bash
# Write the auto-generated brief (all sections filled from interview answers)
# Use jq to read values from 01-discovery.json and template them into the brief
```

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

### Step 6: Relationship Discovery

```bash
bash .agents/skills/healthmodel-discovery/scripts/relationships.sh "$SUB"
```

Prints AKS / Cosmos / ingress / AMW anchors and writes `.healthmodel/data/relationships/rbac/all-assignments.json` (scoped to monitored RGs only).

> **Note**: `.healthmodel/data/` contains potentially sensitive data (RBAC assignments, full resource IDs, diagnostic settings). A `.gitignore` excludes this directory from version control. Regenerate with `export-resources.sh` and `relationships.sh`.

### Step 7: Validate & Present

Present to the user:
- Resource type inventory table
- Detected stamps/regions
- Key resources (compute, data, ingress)
- Gaps (e.g., AKS but no AMW → PromQL signals will fail)

Ask: "Does this look right? Any corrections?"

### Step 8: Save

`.healthmodel/01-discovery.json`:
```json
{
  "subscription": "...",
  "resourceGroups": ["rg-1", "rg-2"],
  "appName": "myapp",
  "location": "swedencentral",
  "mode": "opinionated",
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
  "sensitivity": "balanced",
  "stamps": ["swedencentral-001", "swedencentral-002"],
  "stampFailBehavior": "degraded",
  "sloTargets": "P95 < 500ms, availability > 99.95%",
  "criticalJourneys": "...",
  "topConcerns": "...",
  "excludedResources": [],
  "interviewConfirmed": true,
  "resources": { }
}
```

## Next Step

Announce: *"Discovery complete. `.healthmodel/00-brief.md` (auto-generated from confirmed interview), `.healthmodel/01-discovery.json`, and `.healthmodel/resources.json` are written. Mode: {{mode}}. Load `healthmodel-architecture` to continue."* Then stop — do not auto-proceed.

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| `az account show` fails | Not logged in | `az login` |
| Resources span multiple subscriptions | User mixed scopes | Refuse; pick one subscription |
| No compute resources found | Empty RGs | Stop and ask user for correct RG list |
| `jq: command not found` | jq missing | `brew install jq` or apt equivalent |
| Subscription mismatch | `az account` differs from user's stated subscription | `az account set --subscription <id>` |
