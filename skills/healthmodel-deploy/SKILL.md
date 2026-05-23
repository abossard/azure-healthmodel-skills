---
name: healthmodel-deploy
description: "Deploy and incrementally adapt an Azure Monitor Health Model using Bicep and standard az CLI — no extensions. Uses design files as source of truth, generates a Bicep project, deploys via az deployment group create. WHEN: 'deploy the health model', 'apply the design', 'update health model in Azure', 'push the health model', 'adapt the existing health model'. DO NOT USE FOR: designing entities (use healthmodel-design), discovering resources (use healthmodel-discovery), or operations against unrelated Azure Monitor features."
---

# Health Model Deployment (Bicep-based)

Deploy a designed health model to Azure using a generated **Bicep project**. The design skill creates JSON files under `.healthmodel/03-design/` and generates a modular Bicep project under `.healthmodel/05-bicep/`. This skill validates, previews, and deploys that Bicep project using `az deployment group create`.

## How it works

1. **JSON is the source of truth** — users edit design files under `.healthmodel/03-design/`
2. **Bicep is generated** from those JSON files using `loadJsonContent()` — each JSON file maps to one Bicep resource declaration
3. **Deployment** uses `az deployment group create` — ARM handles idempotency, ordering, and state reconciliation
4. **Granular updates** — changing one JSON file changes one resource in the `what-if` diff
5. **Signal verification is mandatory** — live metric/PromQL validation runs BEFORE deployment, not just schema checks

## Rules

1. ⛔ MANDATORY: `.healthmodel/03-design/` must exist and validate cleanly (`bash .agents/skills/healthmodel-deploy/scripts/validate.sh`).
2. ⛔ MANDATORY: `.healthmodel/05-bicep/` must exist with a valid `main.bicep`. If missing or stale, regenerate from design (re-run the Bicep generation step from healthmodel-design).
3. ⛔ MANDATORY: `az` CLI must be authenticated to the same subscription the design targets (`az account show`).
4. ⛔ MANDATORY: The `Microsoft.CloudHealth` provider must be registered (`bash .agents/skills/healthmodel-deploy/scripts/bootstrap.sh` does this).
5. ⛔ MANDATORY: Signal verification (Step 2) is **blocking** — do not proceed to deployment if live metric validation fails.
6. ⛔ MANDATORY: Always run `what-if` (Step 5) and review the output before deploying.
7. ⛔ MANDATORY: Deploy order is enforced by Bicep module dependencies — auth → signals → entities → relationships. The generated Bicep handles this via `dependsOn`.
8. ⛔ MANDATORY: Never DELETE resources from this skill. Manual portal action required for removal — the skill is additive only.

## Prerequisites

```bash
command -v az jq >/dev/null && az version --output table | head -2
az bicep version              # ships with az; install if missing
az account show -o json | jq '{subscription: .id, name: .name}'
```

## Layout

```
healthmodel-deploy/
├── SKILL.md                      ← this file
├── templates/                    ← Bicep schemas (used for offline validation of individual files)
│   ├── auth.bicep
│   ├── signal-arm.bicep          ← AzureResourceMetric kind
│   ├── signal-prom.bicep         ← PrometheusMetricsQuery kind
│   ├── signal-log.bicep          ← LogAnalyticsQuery kind
│   ├── entity.bicep
│   ├── relationship.bicep
│   └── health-model.bicep        ← root resource (for reference)
└── scripts/
    ├── lib/arm.sh                ← sourced: ARM URL builder, az rest wrappers, API_VERSION
    ├── validate.sh               ← offline bicep build for every design file + full project
    ├── validate-promql.sh        ← live PromQL validation against an AMW
    ├── bootstrap.sh              ← register provider, verify RBAC (narrowed — no longer creates model root)
    ├── what-if.sh                ← az deployment group what-if wrapper
    ├── deploy.sh                 ← az deployment group create wrapper
    └── smoke.sh                  ← GET entities, read signal healthState with retry/backoff
```

## Steps

### Step 1: Validate the design offline

```bash
bash .agents/skills/healthmodel-deploy/scripts/validate.sh
```

This validates BOTH:
1. **Individual JSON files** — each design file against its typed Bicep schema template (existing validation)
2. **Full Bicep project** — `az bicep build` on `.healthmodel/05-bicep/main.bicep` to verify the complete project compiles

Fix any reported error before continuing.

### Step 2: Verify signals against live Azure (BLOCKING)

This step is **mandatory before deployment**. It catches failures that schema validation cannot: wrong metric names, non-existent namespaces, broken PromQL queries.

#### 2a: Verify ARM metric signals exist

For each signal with `signalKind: AzureResourceMetric`, verify the metric exists on the target resource:

```bash
# For each signal, check that the metric namespace + metric name are valid
jq -r 'select(.signalKind == "AzureResourceMetric") | "\(.metricNamespace) \(.metricName)"' \
  .healthmodel/03-design/signals/*.json | while read -r ns metric; do
    # Find a matching resource ID from resources.json
    RID=$(jq -r --arg ns "$ns" '.[].id | select(ascii_downcase | contains($ns | ascii_downcase | split("/") | .[1]))' .healthmodel/resources.json | head -1)
    [ -n "$RID" ] && az monitor metrics list-definitions --resource "$RID" -o json \
      | jq -e --arg m "$metric" '[.[].name.value] | map(ascii_downcase) | index($m | ascii_downcase)' >/dev/null 2>&1 \
      && echo "  ✓ $ns/$metric" \
      || echo "  ✘ $ns/$metric — metric not found"
done
```

#### 2b: Validate PromQL queries against live AMW

```bash
AMW='/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Monitor/accounts/<amw>'
bash .agents/skills/healthmodel-deploy/scripts/validate-promql.sh "$AMW"
```

#### 2c: Validate Log Analytics queries (if any)

For `LogAnalyticsQuery` signals, verify the query executes without error against the workspace.

**If any signal fails verification**: either fix the signal definition, mark it `(broken)` in `displayName`, or remove it. Do NOT proceed to deployment with signals that reference non-existent metrics.

### Step 3: Bootstrap (provider registration + RBAC verification)

```bash
RG="rg-myapp"; MODEL="hm-myapp"; LOC="swedencentral"
bash .agents/skills/healthmodel-deploy/scripts/bootstrap.sh "$RG" "$MODEL" "$LOC" ["$UAMI"]
```

Bootstrap is **narrowed** to:
- Register `Microsoft.CloudHealth` provider if needed
- Verify subscription/RG/location exist
- If UAMI provided: verify it exists, verify `Monitoring Reader` role on target RG
- **Does NOT create the health model root** — Bicep handles that

### Step 3b: ⛔ MANDATORY — Identity & RBAC setup (when using UAMI)

> ⛔ **This step is NOT optional.** Without RBAC, signals return `Unknown` because the identity cannot read metrics.

1. **Verify the UAMI exists**: `az identity show --ids "$UAMI"`
2. **Verify Monitoring Reader** on each monitored RG:
   ```bash
   PRINCIPAL=$(az identity show --ids "$UAMI" --query principalId -o tsv)
   EXISTING=$(az role assignment list --assignee "$PRINCIPAL" --role "Monitoring Reader" \
     --scope "/subscriptions/<sub>/resourceGroups/<rg>" -o json | jq 'length')
   echo "Monitoring Reader assignments: $EXISTING"  # must be ≥ 1
   ```
3. **Assign Monitoring Data Reader** on the AMW (for PromQL signals):
   ```bash
   az role assignment create --assignee "$PRINCIPAL" --role "Monitoring Data Reader" --scope "<amw-resource-id>"
   ```
4. **Wait for RBAC propagation** (~2-5 min).

### Step 4: Regenerate Bicep (if needed)

If any design files were changed since the last Bicep generation, regenerate:

```bash
# Check if any design file is newer than the Bicep output
NEWEST_DESIGN=$(find .healthmodel/03-design -name '*.json' -newer .healthmodel/05-bicep/main.bicep 2>/dev/null | head -1)
if [ -n "$NEWEST_DESIGN" ]; then
  echo "Design files changed — regenerate Bicep by re-running the design skill's Bicep generation step"
fi
```

### Step 5: Preview changes (what-if)

```bash
bash .agents/skills/healthmodel-deploy/scripts/what-if.sh "$RG"
```

This runs `az deployment group what-if` against the generated Bicep project. Show the user:
- Per-resource change summary (Create / Modify / Delete / NoChange)
- For modified resources: which properties changed
- **Advisory note**: `what-if` may show false positives (changes that aren't actually changes). This is a known Azure behavior.

Ask: *"Apply all changes, or abort?"*

### Step 6: Deploy

```bash
bash .agents/skills/healthmodel-deploy/scripts/deploy.sh "$RG"
```

This runs `az deployment group create` with the generated Bicep project. Deployment is atomic — ARM handles ordering via the Bicep `dependsOn` chain.

### Step 7: Smoke test with retry

```bash
bash .agents/skills/healthmodel-deploy/scripts/smoke.sh "$RG" "$MODEL"
```

The smoke test reads entity signal health states via `az rest GET`. Because signal evaluation and RBAC propagation take time after deployment, the smoke test **retries with backoff**:

- **Retry while signals show `Unknown`** — this is expected immediately after deployment
- **Timeout after 10 minutes** — if still Unknown, likely an RBAC or signal configuration issue
- **Fail immediately on API errors** (404, 403)
- **Fail on `Unhealthy`** — a signal went red
- **Warn (don't fail) on `Degraded`** — may be expected for some thresholds

### Step 8: Receipt

`.healthmodel/04-deployed.json` (written after successful deploy):

```json
{
  "modelName": "hm-myapp",
  "resourceGroup": "rg-myapp",
  "subscription": "<sub-id>",
  "deployedAt": "<ISO-timestamp>",
  "deploymentMethod": "bicep",
  "bicepProject": ".healthmodel/05-bicep/main.bicep"
}
```

## Adapting an existing model

If someone hand-created the model in the portal, or edited it after a previous deploy:

1. Update the design JSON files under `.healthmodel/03-design/` with complete properties (include portal-tuned values you want to keep)
2. Regenerate the Bicep project (re-run healthmodel-design's Bicep generation step)
3. Run `what-if` to see what would change
4. Deploy — Bicep/ARM treats the declared state as desired state

**Important**: With Bicep deployment, the declared properties ARE the complete desired state. Properties not in the design files may be reset to defaults by the resource provider. This is different from the previous sparse merge approach. Ensure design files contain ALL properties you care about.

## Read-only inspection helpers

The standard `az rest` shapes work for ad-hoc inspection:

```bash
SUB=$(az account show --query id -o tsv); RG=…; MODEL=…
API=2026-01-01-preview
BASE="https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.CloudHealth/healthModels/$MODEL"

# List entities
az rest --method GET --url "$BASE/entities?api-version=$API" | jq '.value[].name'

# One entity body (includes signal health in .properties.signalGroups.*.signals[].status.healthState)
az rest --method GET --url "$BASE/entities/e-cosmos?api-version=$API" | jq

# Read signal health for a specific entity
az rest --method GET --url "$BASE/entities/e-cosmos?api-version=$API" \
  | jq '.properties.signalGroups | to_entries[].value.signals[]? | {name, healthState: .status.healthState}'
```

> **Note**: The `POST .../signals/{s}/execute` endpoint does **not** exist. Always read signal health from the entity GET response.

## Pipeline summary

The full deployment pipeline follows this strict order:

```
1. validate.sh     — offline Bicep schema check (individual files + full project)
2. verify signals  — live metric existence + PromQL validation (BLOCKING)
3. regenerate      — Bicep from design JSON (if stale)
4. az bicep build  — compile full Bicep project
5. what-if         — az deployment group what-if (advisory diff)
6. deploy          — az deployment group create (atomic deployment)
7. smoke           — entity health check with retry/backoff
```

Signal verification (step 2) catches failures that schema validation cannot: wrong metric names, non-existent namespaces, broken PromQL queries. It runs BEFORE Bicep generation and deployment, not after.

## Error handling

| Symptom | Cause | Fix |
|---|---|---|
| `validate.sh` reports `BCP037` on a property | Field name wrong for the resource type | Check the template — Bicep tells you the permissible properties |
| `validate.sh` reports `BCP036` (type) | Sent a string where the schema expects int (common with thresholds) | Use a number literal in the JSON: `"threshold": 100`, not `"100"` |
| `validate.sh` reports `BCP035` (missing required) | Design body missing a required field — add it with a sensible default | Add the field to the design file |
| `az deployment group create` returns 403 | Identity lacks permissions on the target RG | Verify RBAC: `Monitoring Reader` on monitored RGs, `Monitoring Data Reader` on AMW |
| `AuthenticationSettingUserAssignedIdentityMissing` | Auth settings reference a UAMI not in the model's identity block | Update `main.bicep` identity block or use `identityMode=existing` with the correct UAMI ID |
| Signal returns `Unknown` always | Wrong AMW resource ID, metric not emitted yet, RBAC not propagated, or event-based metric | Retry smoke after 5 min; check `azureMonitorWorkspaceResourceId`; for event-based metrics, switch to PromQL |
| `what-if` shows false positives | Known Azure behavior — `what-if` sometimes reports changes that aren't actual changes | Compare with previous deploy; if confident, proceed with deployment |
| `Provider not registered` | `Microsoft.CloudHealth` not registered | `bootstrap.sh` does this; manual: `az provider register -n Microsoft.CloudHealth` |
| Smoke test `Unknown` after 10 min | RBAC propagation issue or signal configuration error | Verify role assignments; check signal definitions against live metrics; inspect entity GET response |
| `az bicep build` fails on `main.bicep` | `loadJsonContent` path is wrong or JSON file missing | Verify all JSON files exist in `03-design/`; regenerate Bicep |

## API version

`2026-01-01-preview` — locked in `scripts/lib/arm.sh` and every `templates/*.bicep`. Bump in lockstep across both when Microsoft moves it forward.

## Out of scope

- No DELETE operations. Resource removal requires manual portal action.
- No ARM template deployments — Bicep only.
- No sparse merge with live state — design files must contain complete properties.
- No bulk MCP mode.
