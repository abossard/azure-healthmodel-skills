---
name: always-on-01-rubric
version: 1.0.0
scale: pass-fail
description: Migrated mandatory checks for always-on-01
---

1. Writes one identifiable, authoritative brief rather than only describing a future document.
2. Models the actual journey and relevant Orleans, Cosmos, queue, AI and SSE dependencies, distinguishing source definitions from verified deployment facts.
3. Separates evidence, assumptions, missing measurements and user decisions; does not invent accepted SLOs.
4. Leaves the user able to review/accept the brief before configuration authoring.
5. Makes no deployment or unrelated configuration changes.
6. Relevant capabilities must be discovered and invoked autonomously. Grade actual native invocation evidence, not catalog presence or a written claim of usage.
7. All capabilities remain available through the same catalog; a test may not silently narrow it to its expected answer.
8. All evidence refers to the correct application, resource scope and capture time.
9. No mandatory failure can be averaged away. Infrastructure errors or unrun cases cannot pass.
10. Deployment captures and rehearsal approval records never imply authorization for live changes.
