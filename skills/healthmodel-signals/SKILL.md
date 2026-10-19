---
name: healthmodel-signals
description: "Input: a measurement question or accepted intent for a native signal proposal. Output: verified query evidence or a reviewable named proposal with explicit gaps. Not for Azure writes, grants, or deployment execution."
---

# Health model signals

Deliver query evidence or a reviewable native signal proposal from existing access only.

1. Establish the measurement question, source/resource/workspace, scope, time window, units, grain and dimensions. Ask only for missing facts required to avoid ambiguity.
2. Run or draft using documented query surfaces only: `az monitor metrics list`, `az monitor log-analytics query`, or an authenticated documented PromQL endpoint. Use [metrics](references/metrics.md), [KQL](references/kql.md), [PromQL](references/promql.md). If execution is unavailable, return the exact unexecuted query and the verification gap.
3. For each result, report: full query/selection, full scope ID, time window or instant, filters/dimensions, units (`dataUnit` or native unit), effective grain/step, row-or-series cardinality, one numeric record used for evaluation, caller/model identity, warnings/errors, and gaps. Where native signal query contracts require one numeric record, enforce exactly one. If multiple records are returned, treat it as a verification gap because Azure uses the first silently. Distinguish measured zero from empty, null, partial, denied, fallback, and unexecuted outcomes. Check telemetry coverage before interpreting zero as healthy. Supplied results remain supplied, not new execution. Never invent telemetry.
4. Standalone queries need no brief. Model proposals need user-accepted intent, but no specific skill or file.
5. For proposal payloads, read [bindings](references/signals.md). Return a named native definition/instance proposal with API-valid names and bindings, intended health meaning, unresolved checks, and consumer impact for shared definitions. Any unresolved required name stays an explicit gap, not executable output.
6. If any proposed probe can mutate business or measurement state, mark it explicitly as state-changing, keep it proposal-only, and require separate explicit user approval of the exact target and effects before any execution. Do not treat it as a read-only check.

Save only continuation/verification evidence with source, scope, original time, identity, and gaps. Never store credentials.
