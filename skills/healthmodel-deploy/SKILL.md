---
name: healthmodel-deploy
description: "Deploy and incrementally adapt an Azure Monitor Health Model using only standard az CLI (az rest, az bicep) — no extensions. Uses sparse design files: the skill owns the fields it writes, leaves portal edits intact. WHEN: 'deploy the health model', 'apply the design', 'update health model in Azure', 'push the health model', 'adapt the existing health model'. DO NOT USE FOR: designing entities (use healthmodel-design), discovering resources (use healthmodel-discovery), or operations against unrelated Azure Monitor features."
---

# Health Model Deployment (extension-free)

Apply a designed health model to Azure using **only** standard `az` CLI tooling: `az rest`, `az bicep build` (for offline schema validation), `jq`, bash. No third-party extension, no Python SDK, no ARM template orchestration.

## How it works

The skill follows a **sparse-design = ownership** model:

- Each file in `.healthmodel/03-design/{auth,signals,entities,relationships}/*.json` is a *partial* `properties` body. It lists **only the fields the skill is responsible for** — nothing else.
- On every apply, the skill `GET`s the live resource, **deep-merges** the sparse design on top (design wins on overlapping keys), and `PUT`s the result back via `az rest`. Fields the design doesn't mention — including portal edits, manually-added signals, custom tags — are preserved.
- Bicep is used **offline as a schema validator** (`loadJsonContent('body.json')` against the typed `Microsoft.CloudHealth@2026-01-01-preview` resource). Nothing is ever deployed via Bicep or ARM templates.
- "Azure is the state." No local state file. If you want the skill to stop touching a field you tuned in the portal, delete it from the design file.

## Rules

1. ⛔ MANDATORY: `.healthmodel/03-design/` must exist and validate cleanly (`bash .agents/skills/healthmodel-deploy/scripts/validate.sh`).
2. ⛔ MANDATORY: `az` CLI must be authenticated to the same subscription the design targets (`az account show`).
3. ⛔ MANDATORY: The `Microsoft.CloudHealth` provider must be registered (`bash .agents/skills/healthmodel-deploy/scripts/bootstrap.sh` does this).
4. ⛔ MANDATORY: Always run `bash .agents/skills/healthmodel-deploy/scripts/plan.sh` and review the per-resource verdicts before `bash .agents/skills/healthmodel-deploy/scripts/apply.sh`.
5. ⛔ MANDATORY: Apply order is fixed by file ordering — auth, then signal-definitions, then entities, then relationships. Plan walks them in that order; entity signal references must point at existing signal-definitions before the entity PUT.
6. ⛔ MANDATORY: Never DELETE resources from this skill. Manual portal action required for removal — the skill is additive/merge-only.

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
├── templates/                    ← Bicep schemas (validation only, never deployed)
│   ├── auth.bicep
│   ├── signal-arm.bicep          ← AzureResourceMetric kind
│   ├── signal-prom.bicep         ← PrometheusMetricsQuery kind
│   ├── signal-log.bicep          ← LogAnalyticsQuery kind
│   ├── entity.bicep
│   ├── relationship.bicep
│   └── health-model.bicep        ← root resource (for reference)
└── scripts/
    ├── lib/arm.sh                ← sourced: ARM URL builder, az rest wrappers, API_VERSION
    ├── validate.sh               ← offline bicep build for every design file
    ├── bootstrap.sh              ← create the model root resource (idempotent)
    ├── plan.sh                   ← GET live, merge with design, write .healthmodel/04-plan.json
    ├── apply.sh                  ← PUT every non-no-op item from the plan; writes 04-deployed.json receipt
    └── smoke.sh                  ← GET entities, read signal healthState from response body
```

## Steps

### Step 1: Validate the design offline

```bash
bash .agents/skills/healthmodel-deploy/scripts/validate.sh           # walks .healthmodel/03-design/
```

For every file the script: writes it as `body.json` next to the matching `templates/<kind>.bicep`, runs `az bicep build` against the typed schema, fails on any `BCP` warning (missing required prop, wrong type, disallowed field, etc.). No Azure call. Fix any reported error before continuing.

### Step 2: Bootstrap (create/ensure the model exists)

```bash
RG="rg-myapp"; MODEL="hm-myapp"; LOC="swedencentral"
# Without UAMI (system-assigned identity only):
bash .agents/skills/healthmodel-deploy/scripts/bootstrap.sh "$RG" "$MODEL" "$LOC"

# With UAMI (required when auth settings reference a user-assigned managed identity):
UAMI="/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-healthmodel-myapp"
bash .agents/skills/healthmodel-deploy/scripts/bootstrap.sh "$RG" "$MODEL" "$LOC" "$UAMI"
```

Registers `Microsoft.CloudHealth` if needed and `PUT`s the model root. If a UAMI is provided, creates the model with `SystemAssigned,UserAssigned` identity — required before auth settings can reference that UAMI. Idempotent — safe to re-run.

### Step 2b: Identity & RBAC setup (when using UAMI)

After bootstrap, before apply, ensure the identity is ready:

1. **Verify the UAMI exists**: `az identity show --ids "$UAMI"`
2. **Assign Monitoring Reader** on each monitored RG:
   ```bash
   PRINCIPAL=$(az identity show --ids "$UAMI" --query principalId -o tsv)
   az role assignment create --assignee "$PRINCIPAL" --role "Monitoring Reader" --scope "/subscriptions/<sub>/resourceGroups/<rg>"
   ```
3. **Assign Monitoring Data Reader** on the AMW (for PromQL signals):
   ```bash
   az role assignment create --assignee "$PRINCIPAL" --role "Monitoring Data Reader" --scope "<amw-resource-id>"
   ```
4. **Wait for RBAC propagation** (~2-5 min). Signals may return `Unknown` until propagation completes.

### Step 3: Plan

```bash
bash .agents/skills/healthmodel-deploy/scripts/plan.sh "$RG" "$MODEL"
```

For every design file: `arm_get` the live resource → deep-merge → emit a verdict:

| Symbol | Meaning |
|---|---|
| `+ create` | Resource doesn't exist in Azure yet |
| `~ modify` | Resource exists and merged body differs (diff is printed) |
| `= no-op`  | Merged body already matches live — nothing to do |

The full plan is saved to `.healthmodel/04-plan.json` with the merged body for each item.

### Step 4: Review the plan

Show the user:
- Per-resource verdict counts
- For `~ modify` items, the diff between live and merged (preserves user-edited fields *unless* the design explicitly asserts them)
- Any item where design changes a field the user appears to have tuned in the portal — call this out explicitly

Ask: *"Apply all, apply a subset, or abort?"*

### Step 5: Apply

```bash
bash .agents/skills/healthmodel-deploy/scripts/apply.sh              # interactive: prompts y/N
# or
bash .agents/skills/healthmodel-deploy/scripts/apply.sh --yes        # non-interactive (after user explicit OK)
# or
bash .agents/skills/healthmodel-deploy/scripts/apply.sh --only signaldefinitions/sd-cosmos-avail   # one resource
```

Each non-no-op plan item is `PUT` via `az rest`. The merged body (live ∪ design) is sent, so portal edits to unmanaged fields survive.

### Step 6: Smoke test

```bash
bash .agents/skills/healthmodel-deploy/scripts/smoke.sh "$RG" "$MODEL"
```

`GET .../entities?api-version=...` and reads `.properties.signalGroups.*.signals[].status.healthState` from each entity. Prints health state per signal and a summary. Exits non-zero if any signal returns `Unhealthy`.

> **Note**: The signal `/execute` endpoint does NOT exist. Always verify signal health by reading entity state via GET.

### Step 7: Receipt

`.healthmodel/04-deployed.json` (write after a successful apply):

```json
{
  "modelName": "hm-myapp",
  "resourceGroup": "rg-myapp",
  "subscription": "<sub-id>",
  "deployedAt": "<ISO-timestamp>",
  "appliedCount": 0,
  "noopCount": 0
}
```

## Adapting an existing model

If someone hand-created the model in the portal, or edited it after a previous apply: just run the skill normally. Plan shows what the merge *would* change. Apply only touches fields the sparse design names. Anything you set in the portal that isn't in design files is left alone.

To stop the skill from managing a field: **remove the key from the design file**. Next plan will show that field as a no-op (since live and merged agree, because design doesn't speak).

To force-overwrite a portal change: re-add the field to the design file with the value you want. Plan will show `~ modify`, apply will PUT.

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

## Error handling

| Symptom | Cause | Fix |
|---|---|---|
| `validate.sh` reports `BCP037` on a property | Field name wrong for the resource type | Check the template — Bicep tells you the permissible properties |
| `validate.sh` reports `BCP036` (type) | Sent a string where the schema expects int (common with thresholds) | Use a number literal in the JSON: `"threshold": 100`, not `"100"` |
| `validate.sh` reports `BCP035` (missing required) | Sparse body too sparse — the schema requires this field even for partial updates | Add the field to the design file |
| `arm_put` returns 403 | Identity lacks `Monitoring Reader` on the monitored RG(s) | `az role assignment create --assignee <principalId> --role "Monitoring Reader" --scope /subscriptions/<sub>/resourceGroups/<rg>` |
| `AuthenticationSettingUserAssignedIdentityMissing` | Auth settings reference a UAMI not in the model's identity block | Re-run `bootstrap.sh` with the UAMI parameter, or manually PUT the identity block with `SystemAssigned,UserAssigned` + the UAMI ref |
| Signal returns `Unknown` always | Wrong AMW resource ID, metric not emitted yet, or event-based metric with no data (see note below) | Check `azureMonitorWorkspaceResourceId`; verify the metric in `az monitor metrics list-definitions`; for event-based metrics, switch to PromQL/KQL |
| `ResourceTypeRegistrationNotFound` on signal execute | The `/signals/{s}/execute` endpoint does not exist | Use `GET .../entities` and read `.properties.signalGroups.*.signals[].status.healthState` instead |
| `arm_get` fails with unrecognized error | Azure error format includes `Not Found` (with space) or `ResourceReadFailed` | Already handled in `lib/arm.sh`; if new patterns appear, add to the case statement |
| `Provider not registered` | `Microsoft.CloudHealth` not registered | `bootstrap.sh` does this; manual: `az provider register -n Microsoft.CloudHealth` |
| Plan shows `~ modify` for a field the user clearly tuned in the portal | Design file asserts that field — apply will overwrite | Either accept (apply) or remove the key from the design file (ownership-release) |
| Apply overwrites portal edits made between plan and apply | `apply.sh` uses the pre-computed plan body, not live state | Re-run `plan.sh` to refresh before applying if the model was edited between plan and apply |

## API version

`2026-01-01-preview` — locked in `scripts/lib/arm.sh` and every `templates/*.bicep`. Bump in lockstep across both when Microsoft moves it forward.

## Out of scope

- No DELETE operations. Resource removal requires manual portal action.
- No state file. Source of truth is Azure (`az rest GET`) + the sparse design files.
- No bulk MCP mode. Single-PUT-per-resource is the only path; plan/apply is the granularity boundary.
- No ARM template deployments — Bicep is used purely as an offline validator.
