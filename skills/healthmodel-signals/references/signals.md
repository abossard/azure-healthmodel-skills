# Model bindings

## Check the API version

Identify the API version. Check its [signal definitions](https://learn.microsoft.com/rest/api/health-models/signal-definitions/get) and [entities](https://learn.microsoft.com/rest/api/health-models/entities/get) for fields and limits. Block unsupported or conflicting fields.

## Bind sources and access

- Bind one source per signal type per entity through `signalGroups` and `authenticationSetting`. Identify the effective principal.
- Model [access](https://learn.microsoft.com/azure/azure-monitor/health-models/create#permissions-required) requires Reader on represented resources and Monitoring Reader on queried workspaces. Access grants are not automatic.
- A successful user query proves neither that principal's access nor model evaluation.

## Define the signal

Include `signalKind`, definition and instance names, `signalDefinitionName` when reused, `displayName`, supported `refreshInterval`, `dataUnit`, measurement fields and `evaluationRules`.

- `dataUnit` labels values; it does not convert them.
- Test static rules below, at and above each boundary.
- `Dynamic` applies only to the unhealthy rule. Use only requirements supported by the selected schema.

## Name and update signals

- Use descriptive names of 3-260 alphanumeric or hyphen characters, with alphanumeric ends. Definition names must be unique within the model; instance names must be unique within the entity.
- Before editing a shared definition, list its consumers.
- For a rename, keep old and new names, binding changes, and affected group `members` references in the reviewed artifact.
- Report unresolved names. They count as Unknown and can be excluded.

## Verify evaluation

After refresh, use fresh `status.healthState`, `value`, `reportedAt` and `error` to verify evaluation. Provisioning success does not prove evaluation.
