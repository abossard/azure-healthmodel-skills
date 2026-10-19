# Resources and relationships

## Sources and scope

- Use scoped inventory, resource properties and model configuration.
- Prefer documented native reads in `az monitor health-models` (preview extension) when they match the needed read.
- If matching native read coverage is unavailable, use documented `az rest` read fallback with explicit operation and API version. Do not invent subcommands.
- Azure Resource Graph can locate resources. It does not establish runtime reachability or complete dependencies.
- Identify resources by full resource ID and model entities by entity ID/name.
- One resource can back several independently evaluated entities. Keep those entities separate.
- Resources may cross subscriptions within the tenant. Clarify scope before following references beyond the requested scope.
- Use existing available tools and authentication only. Do not auto-install extensions, repair access, or initiate login.

## Relationships

- Models have one root.
- Distinguish dependency relationships from aggregation relationships.
- Label each edge's source: configured connection, declared model relationship, observed traffic, user statement or inference.
- A configured endpoint does not prove reachability. Missing edges do not prove independence.

## Discovery ownership

- Preserve discovery ownership alongside manual entities.
- Discovery runs every five minutes.
- Overlapping manual/discovered entities can duplicate resources.
- Discovered entities cannot be manually deleted.
- Report ownership or freshness gaps. Do not propose repairs.
