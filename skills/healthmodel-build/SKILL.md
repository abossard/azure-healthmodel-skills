---
name: healthmodel-build
description: "Convert accepted health intent plus a specific requested change into reviewable Bicep/ARM or Terraform AzAPI configuration updates and operation steps. Not cloud execution or approval."
---

# Build health model configuration

Return reviewable configuration and a bounded operation plan only. Do not execute Azure writes.

## Establish accepted intent and scope

- Accept intent from conversation context or any user-provided file.
- If intent sources conflict, ask which source is authoritative before authoring.
- Treat changes to thresholds, rollup, impact logic, or entity/signal health semantics as changed health meaning. Require user acceptance of the updated intent before authoring those semantic changes.
- For cosmetic renames or writable-field edits that do not change health meaning, reuse accepted intent and the specific request.
- If accepted intent is missing for a new model, new scope, or changed health meaning, stop and report the gap.
- Access permission or a "build it" request is not acceptance of unseen intent.

Then fix the operating scope:

- establish target model, tenant, subscription, and resource group
- read current affected configuration when the change depends on existing writable state
- identify missing fields or evidence that block a safe update

## Author configuration

Use a selected supported contract for each changed operation and record its API version. Keep fields valid for that version.

Read only the guide sections needed for the change:

- [Contract selection](references/contract.md#select-the-contract)
- [Entities and relationships](references/contract.md#model-and-relationships)
- [Rollup and impact](references/contract.md#rollup-and-impact)
- [Custom signal groups](references/contract.md#custom-signal-groups)
- [Signal bindings](references/contract.md#integrate-signal-bindings)
- [Bounded edits and removals](references/contract.md#bounded-edits-and-removals)

Preserve repository conventions:

- Keep the project’s current supported format instead of forcing a format migration.
- If an output is generated, edit the declared source inputs and run the project’s declared generator path. Do not bypass with hand-authored replacement artifacts.
- Use provided signal instance names from accepted inputs or current readback. Do not invent or silently rename signals. Include all affected references and group memberships when renaming.
- Preserve unrelated writable fields. Use explicit removals when requested. Omission is not a reliable removal method.
- Keep identity/authentication assumptions explicit and separate from ordinary model edits.

For a new Bicep model, [templates/main.bicep](templates/main.bicep) is optional starter structure only.

## Check and hand off

- Validate every emitted Bicep/JSON path, nesting, and value type against the selected writable request schema.
- Run available local structural checks for emitted artifacts.
- If a required check is unavailable or fails, report it and mark related operations non-executable.
- Keep relationship direction and endpoint mapping evidence-grounded. If ambiguous, report a blocking gap instead of guessing.

Return:

- configuration paths or bounded diff
- proposed operations in dependency order, with exact target IDs, operation type, selected API version, and expected effects
- deployment scope/mode and resolved parameters where relevant
- preconditions for each target (reviewed baseline/readback source and observation time, or "must not exist" for new targets)
- missing inputs or checks that block execution
- unresolved targets or placeholders marked as non-executable
- identity/authentication changes and removals listed separately from ordinary edits

An unchanged artifact does not prove target state drift has not changed. The operation list is for review. It is not write approval.
