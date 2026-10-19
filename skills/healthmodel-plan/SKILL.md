---
name: healthmodel-plan
description: "Turn provided health-model context into a clear concept explanation or a reviewed intent brief in the user’s requested format. Not configuration authoring, cloud execution, or incident diagnosis."
---

# Health model plan

## Explain concepts from provided context

Answer concept questions directly from the context the user already provided. Use plain, concrete language.

When useful, anchor explanations to these meanings:

- **Entities** represent user outcomes, supporting flows, and dependencies.
- **Signals** provide health evidence.
- **Relationships and rollup** propagate dependency health into outcome health.
- **Healthy** means working as expected.
- **Degraded** means diminished function or performance.
- **Unhealthy** means not working or unacceptable performance.
- **Unknown** means insufficient evidence.

Missing telemetry is a gap, not proof of health. Downtime accounting does not redefine these states.

## Define or refine health intent

Create or refine intent from conversation context or any user-provided file. Output in the user’s requested form.

For in-scope content, keep:

- user goals and priority outcomes
- supporting flows, dependencies, and resources
- proposed degraded and unhealthy meaning tied to user impact
- evidence, assumptions, unknowns, and open decisions

Keep user facts, observations, and proposals distinct. Do not invent resources, thresholds, or SLOs. Ask only for decisions that block intent quality.

Intent must be user-reviewed before semantic configuration changes. Scope consent is not intent acceptance. Record explicit acceptance in the working artifact or current conversation. If intent changes, mark affected parts pending review until the user accepts the update.

Save evidence only when it helps continuation or verification. Include source, scope, observation window/time, actor identity, and gaps. Exclude credentials.

Return the produced artifact path (if a file was requested) plus unresolved decisions. Stop before configuration authoring or cloud writes.
