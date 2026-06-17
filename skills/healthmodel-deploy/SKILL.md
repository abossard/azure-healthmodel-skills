---
name: healthmodel-deploy
description: "Deploy and incrementally adapt an Azure Monitor Health Model using the `az monitor health-models` CLI extension. Reads sparse JSON design files under `.healthmodel/03-design/` and reconciles them by invoking `az monitor health-models <kind> create` per file (idempotent full-PUT). WHEN: 'deploy the health model', 'apply the design', 'update health model in Azure', 'push the health model', 'adapt the existing health model'. DO NOT USE FOR: designing entities (use healthmodel-design), discovering resources (use healthmodel-discovery), or operations against unrelated Azure Monitor features."
---

# Health Model Deployment

Deploy a designed health model to Azure using the **`az monitor health-models`** CLI extension (preview, `health-models` v1.0.0b1+). The design skill writes JSON files under `.healthmodel/03-design/`; this skill reconciles each file with Azure by invoking the matching `az monitor health-models <kind> create` command.

## How it works

1. **JSON is the source of truth** — users edit design files under `.healthmodel/03-design/`.
2. **`create` is idempotent** — the extension treats `create` as a full PUT. Re-running with the same body overwrites the resource cleanly; re-running with the same file is a safe no-op when content matches.
3. **Cross-references are server-validated** — the reconcile order is fixed: `auth → signal → entity → relationship → discovery-rule`. An entity that references a missing signal-definition fails immediately with `MissingSignalDefinition`.
4. **Live verification uses the extension's read endpoints** — `entity get-signal-history` and `entity show`, never `az rest`.

## Rules

1. ⛔ MANDATORY: The `health-models` Azure CLI extension must be installed (`bash .agents/skills/healthmodel-deploy/scripts/bootstrap.sh` does this).
2. ⛔ MANDATORY: `.healthmodel/03-design/` must exist with at least one auth-setting or one entity. Empty design = nothing to deploy.
3. ⛔ MANDATORY: `az` CLI must be authenticated to the same subscription the design targets (`az account show`).
4. ⛔ MANDATORY: When the model is new, pass `--location` to `reconcile.sh`. The location must be a region that supports `Microsoft.CloudHealth/healthModels` (e.g. `swedencentral`, `uksouth`, `westeurope`). See `~/.minime/wiki/orgs/Azure-Samples/AI-Gateway/cloudhealth-region-availability.md`.
5. ⛔ MANDATORY: Never DELETE resources from this skill. The reconcile flow is additive only — removing a JSON file does not remove the resource in Azure. Manual cleanup via `az monitor health-models <kind> delete` is required.
6. ⛔ MANDATORY: For every signal definition, `refreshInterval` must be ≤ `timeGrain`. The server returns `(InvalidPayload) Refresh interval should be equal or less than time grain.` otherwise.
7. ⛔ MANDATORY: Use `jq` (never `grep`/`sed`) when parsing the extension's JSON output. Repository convention.
8. ⛔ MANDATORY: Every `az` invocation persists its full output to `.healthmodel/data/deploy/<phase>/`. `bootstrap.sh`, `reconcile.sh`, `smoke.sh`, and `discover-auto.sh` already do this — keep the pattern when extending.

## Prerequisites

```bash
command -v az jq >/dev/null && az version --output table | head -2
az account show -o json | jq '{subscription: .id, name: .name}'

# Required: health-models extension (install handled by bootstrap.sh)
bash .agents/skills/healthmodel-deploy/scripts/bootstrap.sh
```

`bootstrap.sh` is idempotent: it installs the `health-models` extension if missing, registers `Microsoft.CloudHealth`, and verifies `az monitor health-models --help` works.

## Layout

```
healthmodel-deploy/
├── SKILL.md                    ← this file
└── scripts/
    ├── bootstrap.sh            ← install extension + register provider
    ├── reconcile.sh            ← idempotent per-file CLI reconcile
    ├── validate-signals.sh     ← pre-deploy: verify each signal has data; auto-mark (broken)/(no data)
    ├── smoke.sh                ← post-deploy: read entity signal health (with --wait retry)
    └── discover-auto.sh        ← fast path: discovery-rule + wait for entities
```

## Steps

### Step 1: Bootstrap (one-time per workstation/CI runner)

```bash
bash .agents/skills/healthmodel-deploy/scripts/bootstrap.sh
```

This installs the `health-models` extension, registers `Microsoft.CloudHealth`, and confirms `az monitor health-models` is callable. Logs land in `.healthmodel/data/deploy/bootstrap/`.

### Step 2 (optional): RBAC for the model's managed identity

When a signal needs to read metrics from a target resource (any `signalKind`), the model's managed identity needs the right role:

```bash
RG="rg-myapp"; MODEL="hm-myapp"
PRINCIPAL=$(az monitor health-models show -g "$RG" -n "$MODEL" --query identity.principalId -o tsv)

# Read ARM metrics (AzureResourceMetric)
az role assignment create --assignee "$PRINCIPAL" --role "Monitoring Reader" \
  --scope "/subscriptions/<sub>/resourceGroups/<monitored-rg>"

# Read AMW Prometheus (PrometheusMetricsQuery)
az role assignment create --assignee "$PRINCIPAL" --role "Monitoring Data Reader" \
  --scope "<amw-resource-id>"

# Read Log Analytics (LogAnalyticsQuery)
az role assignment create --assignee "$PRINCIPAL" --role "Log Analytics Reader" \
  --scope "<workspace-resource-id>"
```

RBAC propagation takes 2-5 min. Signals show `Unknown` until propagation completes.

### Step 3: Reconcile design files

```bash
RG="rg-myapp"; MODEL="hm-myapp"; LOC="swedencentral"
bash .agents/skills/healthmodel-deploy/scripts/reconcile.sh "$RG" "$MODEL" --location "$LOC"
```

`reconcile.sh` walks `.healthmodel/03-design/{auth,signals,entities,relationships,discovery-rules}/*.json` and invokes the matching `az monitor health-models <kind> create` per file. Each file's `properties` body is unwrapped into the relevant `--*-file` arguments (e.g. `.azureResourceMetric` → `--azure-resource-metric @<tmp>`).

Order is fixed because the extension validates cross-references server-side:

```
authentication-setting → signal-definition → entity → relationship → discovery-rule
```

If a step fails, the script tails the last 20 lines of `.healthmodel/data/deploy/reconcile/reconcile-<ts>.log` and exits non-zero. Re-running is safe — `create` is idempotent.

Optional flags:
- `--design <dir>` — use a different design root (default `.healthmodel/03-design`).
- `--dry-run` — print the `az` commands that would be run without executing them.

### Step 3a (recommended): Validate signals against live data BEFORE deploy

```bash
AMW='/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Monitor/accounts/<amw>'
WORKSPACE='/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<law>'

bash .agents/skills/healthmodel-deploy/scripts/validate-signals.sh \
  --amw "$AMW" --workspace "$WORKSPACE"
```

`validate-signals.sh` walks `.healthmodel/03-design/signals/*.json` and tests each one against its live data source:

| `signalKind` | Validation |
|---|---|
| `AzureResourceMetric` | `az monitor metrics list-definitions` confirms the metric exists and `aggregationType` is supported; `az monitor metrics list` confirms a non-null sample in the last hour |
| `PrometheusMetricsQuery` | `az rest GET <amw-endpoint>/api/v1/query` confirms `status: success` and a non-empty result set |
| `LogAnalyticsQuery` | `az monitor log-analytics query` confirms a non-empty result over the last hour |

For each signal, the script mutates `displayName` **idempotently**:

| Outcome | Displayname suffix | Exit-code contribution |
|---|---|---|
| ✓ Query returned data | (none — clean) | 0 |
| ⊘ Query is valid but returned no data in the last hour | `(no data)` | 0 (or 2 with `--strict`) |
| ✘ Query is invalid (metric not found, parse error, unsupported aggregation) | `(broken: <reason>)` | 1 |
| · Could not be tested (no AMW given for a PromQL signal, no matching resource for an ARM signal) | (none) | 0 |

Re-running removes old markers before applying new ones — markers never accumulate. Use `--no-mark` to validate without mutating files (e.g. in CI).

Resolve `broken` signals before deploy. `no-data` signals are deployable but will show `Unknown` until the underlying source starts emitting; keep the marker for portal visibility.

Output: `.healthmodel/data/deploy/validate-signals/report-<ts>.tsv` plus per-signal raw response.

### Step 4: Smoke test signal health

```bash
bash .agents/skills/healthmodel-deploy/scripts/smoke.sh "$RG" "$MODEL"
```

`smoke.sh` enumerates entities with `az monitor health-models entity list`, then calls `az monitor health-models entity show` for each entity to project every `signalGroups[].signals[].status.healthState` using `jq`. Output is written to `.healthmodel/data/deploy/smoke/smoke-<ts>.txt`, with one `entity-<name>.json` snapshot saved per entity.

Exit codes: `0` (all Healthy), `1` (any Unhealthy), `2` (any Unknown remaining).

Add `--with-history` to also call `az monitor health-models entity get-signal-history` for every signal — useful when debugging persistent `Unknown` or wanting raw time-series data:

```bash
bash .agents/skills/healthmodel-deploy/scripts/smoke.sh "$RG" "$MODEL" --with-history
```

Use `--wait` for post-deploy or post-RBAC propagation:

```bash
bash .agents/skills/healthmodel-deploy/scripts/smoke.sh "$RG" "$MODEL" --wait --timeout 600 --interval 30
```

Retries while signals are `Unknown` (expected for 2-10 min after RBAC propagation), fails fast on `Unhealthy`.

For ad-hoc one-shot inspection (no script needed):

```bash
az monitor health-models entity show \
  -g "$RG" --health-model-name "$MODEL" -n e-cosmos \
  --query 'properties.signalGroups.*.signals[].{name:name, state:status.healthState, value:status.value}'

az monitor health-models entity get-signal-history \
  -g "$RG" --health-model-name "$MODEL" \
  --entity-name e-cosmos --signal-name sa-cosmos-avail

az monitor health-models entity get-history \
  -g "$RG" --health-model-name "$MODEL" --entity-name e-cosmos
```

### Step 5 (alternative): Fast-path discovery via `discovery-rule`

For users who do not want to author entities and signals by hand, `discovery-rule` lets Azure auto-populate the model from a Resource Graph query:

```bash
RG="rg-myapp"; MODEL="hm-myapp"
bash .agents/skills/healthmodel-deploy/scripts/discover-auto.sh \
  "$RG" "$MODEL" dr-vms auth-system \
  "resources | where type =~ 'microsoft.compute/virtualmachines' | project id"
```

`discover-auto.sh`:
1. Snapshots existing entity count.
2. Creates a `discovery-rule` with `--add-recommended-signals Enabled --discover-relationships Enabled`.
3. Polls `entity list` until the count rises (timeout 10 min by default).

The CLR-generated entities and signal-definitions get UUID names — they are designed for the portal/auto-managed lifecycle. Combine with manually authored design files for opinionated SLOs alongside auto-discovered scaffolding.

### Step 6: Receipt

After a successful reconcile + smoke, write `.healthmodel/04-deployed.json` for audit:

```bash
DATA=".healthmodel/data/deploy"
LATEST_LOG=$(ls -1t "$DATA"/reconcile/reconcile-*.log 2>/dev/null | head -1)
jq -n \
  --arg model "$MODEL" --arg rg "$RG" \
  --arg sub "$(az account show --query id -o tsv)" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg log "$LATEST_LOG" \
  '{modelName: $model, resourceGroup: $rg, subscription: $sub,
    deployedAt: $ts, deploymentMethod: "az monitor health-models",
    reconcileLog: $log}' > .healthmodel/04-deployed.json
```

## Pipeline summary

```
1. bootstrap.sh         — install extension + register provider (one-time)
2. RBAC                 — assign Monitoring Reader / Monitoring Data Reader / Log Analytics Reader
3. validate-signals.sh  — pre-deploy: confirm each signal has data; auto-mark (broken)/(no data)
4. reconcile.sh         — per-file `az monitor health-models <kind> create` (idempotent)
5. smoke.sh             — `entity list` + tabulate signalGroups[].signals[].status.healthState
```

Steps 3 (validate) and 5 (smoke) are complementary: validate catches *authoring* errors (wrong metric name, broken PromQL) against the data source directly, smoke catches *deployment* errors (RBAC, identity wiring) by reading what the deployed signal evaluators actually observed.

For the fast path, replace steps 3-5 with `discover-auto.sh`. Combine both for hybrid models (manual SLO-driven entities + auto-discovered scaffolding).

## External health reports

Custom probes (synthetic checks, third-party monitoring, batch jobs) can push health state directly without any signal-definition wiring:

```bash
az monitor health-models entity ingest-health-report \
  -g "$RG" --health-model-name "$MODEL" \
  --entity-name e-checkout --signal-name synthetic-probe \
  --health-state Healthy --value 1 --expires-in-minutes 10 \
  --additional-context "HTTP 200 from synthetic probe at $(date -u +%FT%TZ)"
```

The next `entity show` reflects the reported state in `properties.signalGroups.*.signals[].status`. See `healthmodel-signal-catalog/SKILL.md` § External probes for the full pattern.

## Adapting an existing model

If someone hand-created the model in the portal, or edited it after a previous deploy:

1. Update the design JSON files under `.healthmodel/03-design/` with the complete `properties` body (include portal-tuned values you want to keep).
2. Run `reconcile.sh` again — `create` is full-PUT, so the declared properties become the live state. Properties not in the design file may be reset to defaults.
3. Run `smoke.sh --wait` to verify the updated signals report Healthy.

To stop the skill from managing a field that someone tunes in the portal, **remove the entire enclosing resource from `.healthmodel/03-design/`**. The resource stays in Azure (additive-only contract); reconcile no longer touches it.

## Read-only inspection

All inspection uses the extension's read commands (no `az rest`):

```bash
SUB=$(az account show --query id -o tsv); RG=…; MODEL=…

az monitor health-models entity list -g "$RG" --health-model-name "$MODEL" --query '[].name' -o tsv
az monitor health-models signal-definition list -g "$RG" --health-model-name "$MODEL" --query '[].name' -o tsv
az monitor health-models relationship list -g "$RG" --health-model-name "$MODEL" --query '[].{n:name, p:properties.parentEntityName, c:properties.childEntityName}'

az monitor health-models entity show -g "$RG" --health-model-name "$MODEL" -n e-cosmos \
  --query 'properties.signalGroups.*.signals[].{name:name, state:status.healthState, value:status.value}'

az monitor health-models entity get-signal-history -g "$RG" --health-model-name "$MODEL" \
  --entity-name e-cosmos --signal-name sa-cosmos-avail
```

## API version

`2026-01-01-preview` — wrapped by the extension. No skill-side pinning required. The skill works with any extension version that exposes the same command surface (v1.0.0b1 confirmed).

## Error handling

| Symptom | Cause | Fix |
|---|---|---|
| `'health-models' is misspelled or not recognized` | Extension missing | `bash bootstrap.sh` (installs it) |
| `Failed to parse '--managed-identity' argument: dict type value expected` | The CLI help example is wrong; `SystemAssigned` is a dict value | Pass `--managed-identity managed-identity-name=SystemAssigned` (auth JSON uses `managedIdentityName: "SystemAssigned"`) |
| `(InvalidPayload) Refresh interval should be equal or less than time grain` | `refreshInterval > timeGrain` | Set `refreshInterval ≤ timeGrain` (e.g. both `PT5M`) |
| `(MissingSignalDefinition) Entity references non-existing signal definition` | Reconcile ran out of order, or signal JSON missing | Reconcile order is fixed in `reconcile.sh`; check the signal file exists under `signals/` |
| `(NonExistingChildEntity)` on relationship create | Entity JSON missing or `childEntityName` typo | Verify the entity filename matches `childEntityName` |
| Signals stay `Unknown` after 10 min | RBAC propagation incomplete, or identity lacks role | Re-check role assignments on monitored RG / AMW / workspace; wait another 5 min |
| `discover-auto.sh` times out with no entities | Resource Graph query returns 0 rows, or missing `id` column | Test the query: `az graph query -q "<query>"`; the result must include an `id` column |
| `Microsoft.CloudHealth not registered` | Provider not registered | `bootstrap.sh` handles this; manual: `az provider register -n Microsoft.CloudHealth` |

## Out of scope

- No DELETE operations. Removing a JSON file does NOT remove the Azure resource. Manual `az monitor health-models <kind> delete` is required.
- No Bicep generation. If you need IaC integration, install the AVM/CARML `Microsoft.CloudHealth/healthModels` Bicep module separately.
- No bulk MCP/orchestration modes.
