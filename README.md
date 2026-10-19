# Azure Monitor Health Model Skills

Use your AI agent to build Azure Monitor health models, discuss, understand, and refine them.

## Features

| Skill | Use it to |
|---|---|
| [healthmodel-plan](skills/healthmodel-plan/SKILL.md) | Understand health modeling and define user flows, system flows, priorities and health goals. |
| [healthmodel-build](skills/healthmodel-build/SKILL.md) | Build a model from scratch or add, change and remove configuration, including rollup, impact and custom signal groups. |
| [healthmodel-observe](skills/healthmodel-observe/SKILL.md) | Find involved Azure resources and relationships; inspect an existing model and its history. |
| [healthmodel-signals](skills/healthmodel-signals/SKILL.md) | Build and verify metric, KQL and PromQL queries; configure signals and their names. |
| [healthmodel-explain](skills/healthmodel-explain/SKILL.md) | Investigate unhealthy or Unknown states and explain health changes over time. |
| [healthmodel-apply](skills/healthmodel-apply/SKILL.md) | Apply changes you have reviewed and approved, then check the resulting configuration. |

## Install

### GitHub Copilot CLI plugin

In GitHub Copilot CLI:

```text
copilot plugin marketplace add abossard/azure-healthmodel-skills
copilot plugin install azure-healthmodel-skills@azure-healthmodel-skills
```

To update:

```text
copilot plugin update azure-healthmodel-skills
```

### Skills CLI (npx)

Install all skills with the [Skills CLI](https://skills.sh/) and choose your coding agents:

```bash
npx skills add abossard/azure-healthmodel-skills --skill '*'
```

To install a single skill:

```bash
npx skills add abossard/azure-healthmodel-skills --skill healthmodel-observe
```

Installation is project-scoped by default. Add `--global` to make the skills available across projects.

## Usage

Describe your Azure Monitor health model task to your agent

For example:

> Can you help me build a health model for my current project?

> Yesterday, the application was down, but I didn't see it in the health model, can you check what's missing?

> Use healthmodel-signals to write and verify a KQL query for checkout failures.

For a new model, create a health model brief covering user flows, system flows, resources, priorities and degraded/unhealthy meaning. Review and accept it before authoring configuration. Refine that same brief when intent changes; reuse accepted intent for routine edits.

For Azure work, specify the subscription and resource groups, or the existing model's resource ID. Live queries and changes require Azure access; learning and planning do not. Review proposed changes and approve Azure operations when ready.

## Native Waza skill evaluation

This repository now uses native Waza task/rubric grading under `tests/evals/waza/`.

Current scripts:

```bash
npm run eval:validate
npm run eval -- --case intake-confirmed
npm run eval:report -- --result .waza/results/latest/result.json
npm run eval:view -- --results-dir .waza/results --port 31550 --waza-bin /absolute/path/to/waza-darwin-arm64
```

Notes:

- `eval:validate` is offline and uses stock native `eval.validate` through `waza serve --tcp` JSON-RPC.
- `eval` is deny-by-default and currently blocks before inference because no task is safety-admitted yet.
- Current corpus contract is **57 source IDs** mapped to **77 native variant/workflow task rows**.
- Blocked tasks from `tests/evals/waza/manifests/blocked.manifest.json` stay in the selected denominator for reporting.
- `eval:report` computes source coverage success from native task **status** only. Scores are not treated as success.
- Source IDs reconcile against `sourceToVariantTasks.variantTaskIds` from `tests/evals/waza/manifests/source-to-native.manifest.json`.
- Missing, blocked, errored or unrun selected cases are non-success and produce nonzero exit.
- Native raw result JSON is read-only input for `eval:report`. Reporting does not rewrite native outcomes.
- `eval:view` uses stock `waza serve` with loopback defaults and an explicit `--results-dir` root.
- This setup does not currently advertise executable native coverage. It preserves blocked/unproven readiness truthfully until safety admission exists.
- Historical `.promptfoo/` evidence remains preserved and ignored by Git.

## License

[MIT](LICENSE)
