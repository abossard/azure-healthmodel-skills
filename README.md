# Azure Monitor Health Model Skills

Agent skills for building [Azure Monitor Health Models](https://learn.microsoft.com/en-us/azure/azure-monitor/health-model/health-model-overview) end-to-end — from resource discovery to deployment — using **only** the standard `az` CLI, `jq`, and Bash.

No Azure CLI extensions. No Python SDK. No ARM template deployments.

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
| **healthmodel-design** | Create sparse signal definitions, entities, relationships |
| **healthmodel-deploy** | Validate → bootstrap → plan → apply → smoke test |
| **healthmodel-signal-catalog** | Reference: how to discover metrics and write signals for any resource type |
| **healthmodel-orchestrator** | Chains all four phases with human checkpoints |

## Prerequisites

- **Azure CLI** — authenticated (`az login`)
- **jq** — JSON processor
- **az bicep** — ships with modern `az` (used offline for schema validation only)

```bash
az account show -o json | jq '{subscriptionId: .id, name: .name}'
command -v jq && echo "jq: ok"
az bicep version
```

## Install

### Add as a plugin marketplace (recommended)

Open a **Copilot CLI** or **Claude Code** session:

```
/plugin
```

Select **Add marketplace**, then enter the repository:

```
abossard/azure-healthmodel-skills
```

The health model skills will appear in your plugin browser, ready to install with automatic updates.

### Direct install

If you prefer a one-liner from within a session:

```
/plugin install abossard/azure-healthmodel-skills
```

### Manual install

Clone the repo and copy the skills into your agent skills directory:

```bash
git clone https://github.com/abossard/azure-healthmodel-skills.git
cp -R azure-healthmodel-skills/skills/healthmodel-* ~/.agents/skills/
```

### Project-local install

```bash
mkdir -p .agents/skills
cp -R skills/healthmodel-* .agents/skills/
```

## Update

Marketplace plugins update automatically. For manual installs, re-run the install commands — they overwrite existing skills.

## Quick Start

1. **Discover** — `"discover resources for health model"` or `"scan my Azure"`
2. **Fill the brief** — edit `.healthmodel/00-brief.md` with SLOs, journeys, concerns
3. **Map architecture** — `"map architecture"` or `"draw resource graph"`
4. **Design signals** — `"design entities and signals"`
5. **Deploy** — `"deploy the health model"`

Or use the orchestrator: `"create health model"` — it chains all phases.

## Checkpoint Files

All intermediate state is saved to `.healthmodel/` in your project:

| File | Phase | Content |
|---|---|---|
| `00-brief.md` | Discovery | Human-authored: SLOs, journeys, concerns |
| `01-discovery.json` | Discovery | Interview answers + resource inventory |
| `02-graph.json` | Architecture | Dependency graph + entity hierarchy |
| `03-design/**/*.json` | Design | Sparse signal, entity, relationship definitions |
| `04-plan.json` | Deploy | Per-resource verdict before apply |
| `04-deployed.json` | Deploy | Apply receipt |

You can version-control `.healthmodel/`, re-run any phase independently, or resume after interruption.

## How Sparse Design Works

Each design file contains **only the fields the skill manages**. On deploy, the skill deep-merges design onto live state — portal edits to unmanaged fields are preserved. To stop managing a field, remove it from the design file.

## Related

- [always-on-v2](https://github.com/abossard/always-on-v2) — the reference infrastructure project with Bicep codegen for health models

## License

[MIT](LICENSE)
