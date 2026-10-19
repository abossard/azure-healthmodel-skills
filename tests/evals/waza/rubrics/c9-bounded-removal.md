---
name: c9-bounded-removal-rubric
version: 1.0.0
scale: pass-fail
description: Migrated expectations for c9-bounded-removal
---

1. Return a bounded diff with coherent reference changes, preserved unrelated values/shared consumers and explicit identity/history/deletion effects. No interview or Azure write.
2. Resolve rule ownership before child removal. An unmapped field blocks dependent completion. Omission is not claimed to delete Azure state.
