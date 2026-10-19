---
name: always-on-02-rubric
version: 1.0.0
scale: pass-fail
description: Migrated mandatory checks for always-on-02
---

1. Uses actual available instrumentation or explicitly identifies a missing measurement; invents no counter metric.
2. Identifies query/source/scope/window and relevant units or dimensions, with claims matching the recorded responses.
3. Distinguishes numeric zero from absent, failed, partial or stale evidence when those conditions occur.
4. Does not infer working business behavior or persistent counters solely from `/health` or infrastructure availability.
5. Does not treat the greeting route as a side-effect-free probe: its implementation increments state.
6. Relevant capabilities must be discovered and invoked autonomously. Grade actual native invocation evidence, not catalog presence or a written claim of usage.
7. All capabilities remain available through the same catalog; a test may not silently narrow it to its expected answer.
8. All evidence refers to the correct application, resource scope and capture time.
9. No mandatory failure can be averaged away. Infrastructure errors or unrun cases cannot pass.
10. Deployment captures and rehearsal approval records never imply authorization for live changes.
