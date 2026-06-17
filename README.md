# Azure Monitor Health Model Skills

Agent skills for building [Azure Monitor Health Models](https://learn.microsoft.com/en-us/azure/azure-monitor/health-model/health-model-overview) end-to-end — from resource discovery to deployment — using the **`az monitor health-models`** Azure CLI extension (`Microsoft.CloudHealth`, preview).

No ARM templates. No Bicep generation. No Python SDK. The skills drive the extension's idempotent CRUD surface directly.

## What is a Health Model?

An Azure Monitor Health Model gives you a structured, real-time view of your application's health by organizing resources into a tree of entities with signals (metrics, PromQL, KQL queries) that evaluate health state automatically.

## Skills

The workflow chains six skills with human checkpoints between phases:

```
Discovery → Architecture → Design → Deploy
                                      ↑
                            Signal Catalog (reference data)
                            Orchestrator  (chains all phases)
```

| Skill | Purpose |
|---|---|
| **healthmodel-discovery** | Interview user, export Azure resources, generate a brief |
| **healthmodel-architecture** | Build dependency graph, Mermaid diagram, propose entity hierarchy |
| **healthmodel-design** | Author sparse JSON design files (auth, signals, entities, relationships, discovery-rules) |
| **healthmodel-deploy** | Bootstrap → validate signals → reconcile via `az monitor health-models` → smoke test |
| **healthmodel-signal-catalog** | Reference: how to discover metrics, write PromQL/KQL, and verify signals for any resource type |
| **healthmodel-orchestrator** | Chains all four phases with human checkpoints |

## Prerequisites

- **Azure CLI** — authenticated (`az login`)
- **`az monitor health-models` extension** — installed via `az extension add --name health-models --yes` (handled by `bootstrap.sh`)
- **jq** — JSON processor

```bash
az account show -o json | jq '{subscriptionId: .id, name: .name}'
az extension show --name health-models >/dev/null 2>&1 \
  || az extension add --name health-models --yes
command -v jq && echo "jq: ok"
```

## Install

### 1. Add the marketplace

```bash
copilot plugin marketplace add abossard/azure-healthmodel-skills
```

Or from inside a session:

```
/plugin marketplace add abossard/azure-healthmodel-skills
```

### 2. Install the plugin

```bash
copilot plugin install azure-healthmodel-skills@azure-healthmodel-skills
```

Or from inside a session:

```
/plugin install azure-healthmodel-skills@azure-healthmodel-skills
```

### Manual install

```bash
git clone https://github.com/abossard/azure-healthmodel-skills.git
cp -R azure-healthmodel-skills/skills/healthmodel-* ~/.agents/skills/
```

## Update

```bash
copilot plugin update azure-healthmodel-skills
```

## Quick Start

1. **Discover** — `"discover resources for health model"` or `"scan my Azure"`
2. **Fill the brief** — answer the interview; the brief auto-generates into `.healthmodel/00-brief.md`
3. **Map architecture** — `"map architecture"` or `"draw resource graph"`
4. **Design signals** — `"design entities and signals"`
5. **Deploy** — `"deploy the health model"` → bootstrap + RBAC + validate-signals + reconcile + smoke

Or use the orchestrator: `"create health model"` — it chains all phases.

### Fast path (skip design)

If you want Azure to auto-populate the model from a Resource Graph query:

```bash
RG=rg-myapp; MODEL=hm-myapp
bash .agents/skills/healthmodel-deploy/scripts/bootstrap.sh
az monitor health-models create -g "$RG" -n "$MODEL" -l swedencentral --mi-system-assigned
az monitor health-models authentication-setting create -g "$RG" --health-model-name "$MODEL" \
  -n auth-system --managed-identity managed-identity-name=SystemAssigned
bash .agents/skills/healthmodel-deploy/scripts/discover-auto.sh \
  "$RG" "$MODEL" dr-vms auth-system \
  "resources | where type =~ 'microsoft.compute/virtualmachines' | project id"
```

## Checkpoint Files

All intermediate state is saved to `.healthmodel/` in your project:

| File | Phase | Content |
|---|---|---|
| `00-brief.md` | Discovery | Auto-generated: SLOs, journeys, concerns, alert philosophy |
| `01-discovery.json` | Discovery | Interview answers + resource inventory |
| `resources.json` | Discovery | Minimal resource projections |
| `02-graph.json` | Architecture | Dependency graph + entity hierarchy |
| `02-architecture.md` | Architecture | Mermaid diagram + resource table |
| `03-design/auth/*.json` | Design | Authentication-setting bodies |
| `03-design/signals/*.json` | Design | Signal-definition bodies (flat `properties` shape) |
| `03-design/entities/*.json` | Design | Entity bodies (with `signalGroups` for leaves) |
| `03-design/relationships/*.json` | Design | Parent-child relationship bodies |
| `03-design/discovery-rules/*.json` | Design | Discovery-rule bodies (optional, fast path) |
| `data/deploy/reconcile/*.log` | Deploy | Per-call `az` output and exit codes |
| `data/deploy/validate-signals/report-*.tsv` | Deploy | Pre-deploy signal validation report |
| `data/deploy/smoke/smoke-*.txt` | Deploy | Tabulated post-deploy signal health |
| `04-deployed.json` | Deploy | Apply receipt |

You can version-control `.healthmodel/` (note: `data/` is gitignored — it may contain sensitive RBAC data), re-run any phase independently, or resume after interruption.

## How the deploy works

The `healthmodel-deploy` skill's `reconcile.sh` walks `.healthmodel/03-design/{auth,signals,entities,relationships,discovery-rules}/*.json` and invokes the matching `az monitor health-models <kind> create` per file. Because the extension's `create` is **idempotent full-PUT**, re-running is safe — the declared properties become the live state. To stop managing a field, remove the enclosing resource from the design (additive-only contract).

The order is fixed because the extension validates cross-references server-side:

```
authentication-setting → signal-definition → entity → relationship → discovery-rule
```

`validate-signals.sh` runs before reconcile and verifies each signal has real data:

- ARM metrics → `az monitor metrics list-definitions` + `az monitor metrics list`
- PromQL → `az rest GET <amw>/api/v1/query?query=…`
- KQL → `az monitor log-analytics query`

Broken queries are auto-marked `(broken: <reason>)` in `displayName`, no-data queries get `(no data)`. Markers are idempotent — they never accumulate across runs.

`smoke.sh` runs after reconcile and reads every entity's `signalGroups[].signals[].status.healthState` via `az monitor health-models entity list`, with optional retry while `Unknown` (post-RBAC propagation).

## Related

- [always-on-v2](https://github.com/abossard/always-on-v2) — the reference infrastructure project that pioneered the Health Model patterns this skill set codifies
- [`Azure/azure-cli-extensions/src/health-models`](https://github.com/Azure/azure-cli-extensions/tree/main/src/health-models) — the upstream CLI extension this skill set drives

## License

[MIT](LICENSE)
