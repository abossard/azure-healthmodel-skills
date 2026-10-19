---
name: healthmodel-observe
description: "Retrieve scoped Azure resource topology plus health-model configuration, current state, and retained history facts, with clear observed versus inferred gaps."
---

# Observe

Return resource and model facts. Do not construct telemetry queries, diagnose causes, or change Azure.

1. Identify requested targets and time window from the provided context. Ask only for materially missing identifiers or time bounds required for live reads; never broad-scan to guess scope.
2. Reuse supplied evidence first. For live reads, keep scope explicit (tenant, subscription, model/resource IDs) and use existing auth plus documented read operations only.
3. Use this skill's references for boundaries: [resources and relationships](references/discovery.md) and [state and history](references/history.md). Retrieve only facts needed for the request.
4. Never infer permission from HTTP verb alone. Judge read versus write by operation effect. Query POST can still be read-only; any mutating effect is out of scope.
5. Complete pagination inside scope. Report denied, failed, throttled, truncated, partial, missing, and empty outcomes distinctly. Empty means no match in the examined scope/filter, not an absent workload. If access is unavailable, answer from supplied evidence and label unobserved facts.
6. Return full resource IDs, entity/model identity, source, scope, original timestamps/time window, collection time, and material gaps. Separate observed, user-stated, factual from source, and inferred statements.

Save plain notes/native results only when useful for continuation or verification. Retain source, scope, original time/window, caller identity and gaps; minimize sensitive data and exclude credentials. A one-off answer needs no file or findings index.
