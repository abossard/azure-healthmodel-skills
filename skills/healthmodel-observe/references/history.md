# State and history

## Current health

- Retrieve actual entity/signal status. Provisioning success does not establish current health.
- Keep configuration, evaluated state and historical observations separate.
- Current configuration cannot establish what was configured earlier.

## Historical coverage

- Pin the model/entity, requested interval and timezone.
- Preserve original event/evaluation timestamps and retrieval time.
- When timestamps are missing or redacted, state them as unknown instead of inferring order.
- Health history is retained for 30 days. Disclose unavailable coverage instead of inventing older events.
- Use a separate attributable source for configuration changes. A health-state timeline does not establish them.

## Disagreements and gaps

Current-health and history views update independently and may briefly disagree. Return both with their times and gaps. Do not resolve discrepancies by guessing.

Report returned errors and missing observations without diagnosing their cause.
