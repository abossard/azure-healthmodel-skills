---
name: healthmodel-explain
description: "Diagnose observed states of a specific existing Microsoft.CloudHealth health model or entity using configuration, evaluated signals and history, explicitly separating provisioning, configured monitoring and evaluated health evidence."
---

# Explain health

Explain a specific model/entity using provided evidence first. Ask for missing identity (model, entity, scope) only when required. Do not diagnose guessed targets.
Take only conclusion-changing, read-only-by-effect facts within the explicit model/entity/window. If target identity remains unresolved, ask rather than guess. If live reads are unavailable, answer from supplied evidence and label unobserved facts.

1. Read the evaluated health status `error` fields. List any non-empty `error` values first in the output, before `healthState` and `value`. Do not infer health from `healthState` when an error is present.
2. Compute freshness from `reportedAt`, configured refresh interval, and current time. State age and basis. If required timestamps or refresh settings are unavailable, state freshness as unknown.
3. Separate and label three evidence layers in the output: (1) provisioning/configuration state, (2) monitoring configuration/coverage, and (3) evaluated health status (`healthState`, `value`, `reportedAt`, `error`). Include what was observed for each layer and what remains unobserved.
4. Separate caller samples from model-identity access results within each layer. Caller success or provisioning Succeeded does not prove evaluation.

When a claim depends on telemetry query design, execution details, units, dimensions, aggregation behavior, or measurement source identity, require explicit evidence for those properties. Without that evidence, mark numeric and query-dependent claims unverified.

Trace contributing signals and dependencies through configured thresholds, rollup and impact. Distinguish evaluated Unhealthy from broken measurement. Unknown is not evidence of Healthy or Unhealthy. For health objectives, Degraded does not count as downtime. Inspect group `unresolvedMembers`/`ignoreUnknown`: ignored members can mask gaps.

When exact threshold/aggregation boundaries matter, resolve the [selected API-version contract](https://learn.microsoft.com/rest/api/health-models/entities/get#signalaggregationgroup). Disclose conflicting published descriptions; don't assume inclusivity.

For changes, align state, configuration and measurement timestamps. Service history retains 30 days; current/history views update independently. If the requested window starts more than 30 days before the current UTC time, state that history before that cutoff is unavailable and limit conclusions to the retained period. Check external-report expiry: removal/recalculation does not prove recovery. Nearby deployments do not establish causation.

Explicitly report denied/failed/truncated/partial reads and how they limit confidence. Do not present incomplete evidence as complete coverage.

Finish with evidence-linked explanation, uncertainty, and the next discriminating check. No planning interview, authoring, deployment, or compulsory report/index.

Save evidence only when the user asks to retain it or when the investigation is unresolved and the next check depends on this evidence. Include source, scope, original time/window, caller/model identity and gaps; no credentials.
