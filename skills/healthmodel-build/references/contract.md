# Native configuration guide

## Select the contract

Use the documented `Microsoft.CloudHealth/healthmodels` surface. Do not use private DSLs or invented fields.

- Select a currently supported API for each changed resource and operation. Keep emitted fields and property paths valid for that API.
- For Bicep/schema sources, use the changed resource type docs directly: [model][model], [entities][entities], [relationships][relationships], [authentication settings][auth].
- For REST operation sources, link the changed operation contract directly. For entity create/update use [put][put], and use selected readback contracts like [get][get] for response-only fields and behavior checks.
- Use the project’s existing supported format. Do not force a Terraform project to switch to Bicep.
- Bicep/REST publication can differ. Provider metadata alone does not prove operation success.
- If existing writable fields are absent from the selected contract, stop and resolve the mismatch. Do not silently drop fields.
- If local type schema is unavailable, mark validation as unproved. Absence of local schema is not proof that arbitrary fields are supported.

### Tooling scope and local checks

- **Bicep/ARM:** use native `Microsoft.CloudHealth/healthmodels` resources with a selected supported API version. Run `bicep build --no-restore` for local structure checks only. Optional what-if is remote and does not validate evaluated application health.
- **Terraform AzAPI:** use `Azure/azapi` with `azapi_resource` using selected type and API version in project format. `azapi_update_resource` must follow documented operation semantics. Do not assume PATCH-like merge behavior.
- **Terraform validation:** `terraform fmt` and `terraform validate` are local when required plugins are present. `terraform plan` can contact Azure, state backends, or other preflight services. `terraform apply` requires separate explicit approval.
- Do not auto-init providers, auto-install tools, auto-login, or auto-grant permissions.

## Model and relationships

### Model and root

- A new model requires name, supported location, and chosen identity configuration.
- Azure creates one root entity. In the [Bicep tutorial][tutorial], root name matches model name.
- To update root settings, read existing root and update it. Do not create a second root.

### Entities and graph edges

- Entity ARM/Bicep `parent` is the health model resource.
- Graph edges are separate `healthmodels/relationships` resources.
- Use `properties.parentEntityName` for consuming/aggregating entity and `childEntityName` for dependency. Health flows from child to parent.
- Relationship endpoints must exist in the same model.
- Bind Azure resources via `properties.signalGroups.azureResource.azureResourceId`.
- Logical entities can exist without direct Azure resource bindings.
- A leaf without signals is Unknown, not Healthy.
- One Azure resource can back several entities. Keep distinct workload roles separate.
- In `2026-09-01-preview`, `EntityProperties` has no `kind` field. Do not emit `properties.kind: 'Generic'`.

### Names

Enforce naming constraints before generating IDs:

- Model name: 3-44 chars, starts with letter, ends alphanumeric.
- Entity, relationship, signal, and group names: 3-260 chars with alphanumeric ends.
- Allowed interior chars are letters, digits, or hyphens.
- Entity names must not collide with root name.

### Discovery ownership

When state indicates discovery ownership:

- Manual/discovered overlap can duplicate representations.
- Discovered entities cannot be deleted manually.
- Do not alter discovery rules silently to bypass restrictions.

See [concepts][concepts] and [discovery FAQ][faq].

## Rollup and impact

### Child impact

Set `properties.impact` on the child entity. It applies to all parents of that child:

- `Standard` propagates state.
- `Limited` suppresses Degraded and maps Unhealthy to Degraded.
- `Suppressed` propagates nothing.

### Parent rollup

Set `properties.signalGroups.dependencies` on the parent entity:

- `WorstOf` propagates worst state.
- `BestOf` propagates best non-Unknown state.
- In selected REST definitions, `MinHealthy` means healthy count/percentage at or below threshold.
- In selected REST definitions, `MaxNotHealthy` means not-healthy count/percentage at or above threshold.

### Threshold rules

- For threshold strategies, use `unit`, `unhealthyThreshold`, optional `degradedThreshold`, and deliberate `ignoreUnknown`.
- For explicit degraded bands, MinHealthy degraded threshold is above unhealthy threshold. MaxNotHealthy degraded threshold is below.
- Omitting degraded threshold removes degraded band behavior.
- Validate `Absolute` counts and `Percentage` values against intended population.
- With `ignoreUnknown: true`, threshold math excludes Unknown members, including percentage denominators.

When docs conflict on boundary interpretation, cite selected [REST definitions][get] and record expected behavior below, at, and above each threshold for the accepted goal.

Computed expectations are not service evaluation. Do not claim observed threshold inclusivity without controlled evaluation.
Use the [rollup tutorial][rollup] for workload semantics only, not for operator syntax.

## Custom signal groups

Use `SignalAggregationGroup` at `properties.signalAggregationGroups`. Each group has `name`, `members`, and `aggregationType`.

### Members

- `members` must reference signal instance names on the entity.
- `members` must match signal instance names, not definition names or display names.
- A signal can appear in multiple groups.
- A single group member list cannot repeat the same signal name.
- Reject accidental unresolved members before handoff.
- Intentional or unverified external members stay explicit as gaps and are not executable.
- Keep unresolved member names explicit as unresolved gaps. They evaluate as Unknown.
- The API accepts unknown names and reports `unresolvedMembers`; those entries count as Unknown.

### Strategy settings and results

- For `MinHealthy` and `MaxNotHealthy`, include `unit` and `unhealthyThreshold`, with optional `degradedThreshold`.
- For `WorstOf` and `BestOf`, omit threshold fields.
- `ignoreUnknown` defaults true and affects threshold strategies. It has no observable effect for WorstOf or BestOf.
- A group with no resolvable members, or all members filtered out, is Unknown.
- Group results contribute to the entity worst-of composite alongside ungrouped signals and dependency rollup.
- Grouped signals are not also counted as ungrouped for the same group contribution.
- Overlapping groups evaluate independently.

## Integrate signal bindings

### Sources and authentication

- Preserve provided source and authentication context.
- Each entity supports one data source per signal type.
- Multiple signals may share that source.
- Multiple workspaces require separate entities under a common parent, not duplicate same-type source fields.
- For metric, KQL, or PromQL bindings, verify referenced authentication settings exist and map to intended model identity.
- A user’s successful query does not prove model-identity access.
- Required least-privilege grants must be listed as separate operations, not implicit deployment side effects.

See [signal configuration][signals] and [permission requirements][permissions].

### Shared definitions and evaluation

- Reusable signal-definition edits affect all consumers.
- Deletion of in-use definitions is blocked.
- Identify consuming entities before integrating definition changes.
- Do not submit external reports to mask incomplete model evidence.

## Bounded edits and removals

### Writable state

- Preserve writable identity, tags, alerts, health objectives, layout, bindings, and groups.
- Remove contract-defined read-only response fields (status, computed health, provisioning metadata) from write payloads.
- For Bicep child-only changes, declare unchanged model as `existing`.
- For each written resource, represent complete intended writable state.
- For API updates, follow documented operation semantics and preserve unrelated fields/array entries.
- If required current state or contract details are missing, stop the affected update and report the gap.

### Deployment omission

In [incremental deployment][incremental]:

- omitted resources remain unchanged
- included resources are reapplied, so unspecified properties can reset

Omitting entity or relationship declarations does not remove them. Do not use resource-group complete mode for narrow removal workflows.

### Explicit removal

For requested removals:

- identify exact entity, relationship, group, or signal plus consumers
- propose required reference/member/relationship updates
- propose selected contract’s explicit delete or containing-resource update
- order operations so dependencies remain valid

Do not assume cascading deletion. [Entity deletion][delete] cannot override root/discovery restrictions. Removing model representation is not deletion of the represented Azure resource.

[model]: https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/healthmodels
[entities]: https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/healthmodels/entities
[relationships]: https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/healthmodels/relationships
[auth]: https://learn.microsoft.com/azure/templates/microsoft.cloudhealth/healthmodels/authenticationsettings
[put]: https://learn.microsoft.com/rest/api/health-models/entities/create-or-update
[get]: https://learn.microsoft.com/rest/api/health-models/entities/get
[delete]: https://learn.microsoft.com/rest/api/health-models/entities/delete
[tutorial]: https://learn.microsoft.com/azure/azure-monitor/health-models/tutorial-bicep
[concepts]: https://learn.microsoft.com/azure/azure-monitor/health-models/concepts
[rollup]: https://learn.microsoft.com/azure/azure-monitor/health-models/rollup
[faq]: https://learn.microsoft.com/azure/azure-monitor/health-models/health-models-faq
[signals]: https://learn.microsoft.com/azure/azure-monitor/health-models/signals
[permissions]: https://learn.microsoft.com/azure/azure-monitor/health-models/create#permissions-required
[incremental]: https://learn.microsoft.com/azure/azure-resource-manager/templates/deployment-modes#incremental-mode
