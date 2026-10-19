import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { __testOnly } from "./run.mjs";

test("assertValidateResult accepts valid=true and rejects schema/type errors", () => {
  __testOnly.assertValidateResult({ valid: true, errors: [] });
  assert.throws(
    () =>
      __testOnly.assertValidateResult({
        valid: false,
        errors: [
          "schema: /version: got number, want string",
          "schema: /config/parallel: got number, want boolean",
        ],
      }),
    /Native eval\.validate failed with 2 error\(s\)/
  );
});

test("deriveTaskIdsFromMapping supports taskPath and variant taskIds", () => {
  assert.deepEqual(__testOnly.deriveTaskIdsFromMapping({ taskPath: "tests/evals/waza/tasks/c4-h1.yaml" }), ["c4-h1"]);
  assert.deepEqual(
    __testOnly.deriveTaskIdsFromMapping({ taskIds: ["c4-h1--v1", "c4-h1--v2"] }),
    ["c4-h1--v1", "c4-h1--v2"]
  );
});

test("buildSelection groups duplicate sourceId mapping rows into required variant task ids", () => {
  const sourceManifest = {
    sourceToVariantTasks: [
      { sourceId: "c4-h1", variantTaskIds: ["c4-h1--v1"] },
      { sourceId: "c4-h1", variantTaskIds: ["c4-h1--v2"] },
      { sourceId: "c4-h2", variantTaskIds: ["c4-h2--v1"] },
    ],
  };
  const selected = __testOnly.buildSelection({ sourceManifest, requestedSourceIds: ["c4-h1", "c4-h2"] });
  assert.deepEqual(selected.selectedSourceIds, ["c4-h1", "c4-h2"]);
  assert.deepEqual(selected.selectedTaskIds, ["c4-h1--v1", "c4-h1--v2", "c4-h2--v1"]);
});

test("buildSourceCoverageReport consumes real Waza tasks[].test_id and preserves blocked/unrun", () => {
  const mappingBySource = new Map([
    ["c4-h1", new Set(["c4-h1--v1", "c4-h1--v2"])],
    ["c4-h2", new Set(["c4-h2--v1"])],
    ["always-on-01", new Set(["always-on-01--v1"])],
    ["c4-h3", new Set(["c4-h3--v1"])],
  ]);
  const blockedManifest = {
    blockedTasks: [
      {
        sourceId: "always-on-01",
        taskId: "always-on-01--v1",
        readinessReasons: ["blocked:private-workflow-capture-set-unavailable"],
        safetyReason: "blocked:safety-admission-unproven",
      },
    ],
  };
  const syntheticNativeResult = {
    tasks: [
      { test_id: "c4-h1--v1", status: "passed" },
      { test_id: "c4-h1--v2", status: "passed" },
      { test_id: "c4-h2--v1", status: "failed" },
      { test_id: "c4-h3--v1", status: "error" },
    ],
  };

  const report = __testOnly.buildSourceCoverageReport({
    selectedSourceIds: ["c4-h1", "c4-h2", "always-on-01", "c4-h3"],
    mappingBySource,
    blockedManifest,
    resultPayload: syntheticNativeResult,
  });

  assert.equal(report.totals.tests, 4);
  assert.equal(report.totals.failures, 1);
  assert.equal(report.totals.errors, 1);
  assert.equal(report.totals.skipped, 1);
  assert.equal(report.nonSuccess, true);
  assert.deepEqual(
    report.cases.map((entry) => [entry.id, entry.state]),
    [
      ["c4-h1", "pass"],
      ["c4-h2", "fail"],
      ["always-on-01", "blocked"],
      ["c4-h3", "error"],
    ]
  );
});

test("extractBlockedSourceReasons collapses blockedTasks by sourceId", () => {
  const blockedMap = __testOnly.extractBlockedSourceReasons({
    blockedTasks: [
      {
        sourceId: "c4-h4",
        taskId: "c4-h4--v1",
        readinessReasons: ["blocked:unsupported-forbidden-operation-toolconstraint-mapping"],
        safetyReason: "blocked:safety-admission-unproven",
      },
      {
        sourceId: "c4-h4",
        taskId: "c4-h4--v2",
        readinessReasons: ["blocked:unsupported-denied-attempt-evidence-contract"],
        safetyReason: "blocked:safety-admission-unproven",
      },
    ],
  });
  const reasons = [...(blockedMap.get("c4-h4") ?? [])];
  assert.equal(reasons.includes("blocked:safety-admission-unproven"), true);
  assert.equal(reasons.includes("blocked:unsupported-forbidden-operation-toolconstraint-mapping"), true);
  assert.equal(reasons.includes("blocked:unsupported-denied-attempt-evidence-contract"), true);
});

test("buildSourceCoverageReport marks missing required variant results as unrun", () => {
  const mappingBySource = new Map([["c5-p1", new Set(["c5-p1--v1", "c5-p1--v2"])]]);
  const report = __testOnly.buildSourceCoverageReport({
    selectedSourceIds: ["c5-p1"],
    mappingBySource,
    blockedManifest: { blocked: [] },
    resultPayload: { tasks: [{ test_id: "c5-p1--v1", status: "passed" }] },
  });
  assert.equal(report.cases[0].state, "unrun");
  assert.match(report.cases[0].reason, /missing-native-result/);
});

test("buildJUnit emits source coverage suite with skipped for blocked/unrun", () => {
  const xml = __testOnly.buildJUnit({
    totals: { tests: 3, failures: 0, errors: 1, skipped: 1 },
    nonSuccess: true,
    cases: [
      { id: "a", state: "pass", reason: null },
      { id: "b", state: "blocked", reason: "blocked:reason" },
      { id: "c", state: "error", reason: "native-task-error" },
    ],
  });
  assert.match(xml, /testsuite name="waza-source-coverage"/);
  assert.match(xml, /<skipped message="blocked">/);
  assert.match(xml, /<error message="runtime error">/);
});

test("classifyStatus table", () => {
  const samples = [
    ["passed", "pass"],
    ["completed", "pass"],
    ["failed", "fail"],
    ["error", "error"],
    ["blocked", "unrun"],
    ["skipped", "unrun"],
    ["cancelled", "unrun"],
    ["UNKNOWN", null],
  ];
  for (const [input, expected] of samples) {
    assert.equal(__testOnly.classifyStatus(input), expected, `status=${input}`);
  }
});

test("private output writers enforce 0700 dirs and 0600 files for selection/json/junit paths", async () => {
  const privateParent = path.join(process.cwd(), ".waza");
  await mkdir(privateParent, { recursive: true, mode: 0o755 });
  const scratchRoot = await mkdtemp(path.join(privateParent, "privacy-fix-"));
  try {
    const privateRoot = scratchRoot;
    await chmod(privateRoot, 0o755);
    const cases = [
      { kind: "selection", rel: "selection.json", writer: "json" },
      { kind: "report-json", rel: "reports/report.json", writer: "json" },
      { kind: "report-junit", rel: "reports/report.junit.xml", writer: "text" },
    ];
    for (const entry of cases) {
      const filePath = path.join(privateRoot, entry.rel);
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
      await chmod(path.dirname(filePath), 0o755);
      await writeFile(filePath, "legacy", "utf8");
      await chmod(filePath, 0o644);

      if (entry.writer === "json") {
        await __testOnly.writeJsonPrivate(filePath, { kind: entry.kind });
      } else {
        await __testOnly.writePrivateFileAtomic(filePath, "<testsuite/>");
      }

      const dirMode = (await stat(path.dirname(filePath))).mode & 0o777;
      const fileMode = (await stat(filePath)).mode & 0o777;
      assert.equal(dirMode, 0o700, `dir mode for ${entry.kind}`);
      assert.equal(fileMode, 0o600, `file mode for ${entry.kind}`);
      const data = await readFile(filePath, "utf8");
      assert.equal(data.length > 0, true, `content written for ${entry.kind}`);
    }
    const rootMode = (await stat(privateRoot)).mode & 0o777;
    assert.equal(rootMode, 0o700, "root .waza mode");
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
});

test("private dir chain rejects symlinked owned root segments without foreign writes or mode changes", async () => {
  await mkdir(path.join(process.cwd(), ".waza"), { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(process.cwd(), ".waza", "symlink-fix-"));
  try {
    const scenarios = [
      {
        label: "stateRoot-symlink",
        setup: async () => {
          const foreignRoot = path.join(root, "foreign-root");
          await mkdir(foreignRoot, { recursive: true, mode: 0o755 });
          await chmod(foreignRoot, 0o755);
          const stateRoot = path.join(root, "state-root");
          await symlink(foreignRoot, stateRoot);
          return {
            stateRoot,
            foreignRoot,
            targetFile: path.join(stateRoot, "results", "x.json"),
            foreignProbeDir: path.join(foreignRoot, "results"),
            foreignProbeFile: path.join(foreignRoot, "results", "x.json"),
          };
        },
      },
      {
        label: "nested-segment-symlink",
        setup: async () => {
          const foreignRoot = path.join(root, "foreign-nested");
          await mkdir(foreignRoot, { recursive: true, mode: 0o755 });
          await chmod(foreignRoot, 0o755);
          const stateRoot = path.join(root, "state-root-nested");
          await mkdir(stateRoot, { recursive: true, mode: 0o700 });
          await symlink(foreignRoot, path.join(stateRoot, "results"));
          return {
            stateRoot,
            foreignRoot,
            targetFile: path.join(stateRoot, "results", "sub", "x.json"),
            foreignProbeDir: path.join(foreignRoot, "sub"),
            foreignProbeFile: path.join(foreignRoot, "sub", "x.json"),
          };
        },
      },
    ];

    for (const scenario of scenarios) {
      const values = await scenario.setup();
      const beforeMode = (await stat(values.foreignRoot)).mode & 0o777;
      await assert.rejects(
        __testOnly.writeJsonPrivate(values.targetFile, { blocked: true }, { stateRoot: values.stateRoot }),
        /Refusing symlinked state/
      );
      const afterMode = (await stat(values.foreignRoot)).mode & 0o777;
      assert.equal(afterMode, beforeMode, `${scenario.label}: foreign root mode unchanged`);
      const foreignDirExists = await stat(values.foreignProbeDir)
        .then(() => true)
        .catch((error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
      const foreignFileExists = await stat(values.foreignProbeFile)
        .then(() => true)
        .catch((error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
      assert.equal(foreignDirExists, false, `${scenario.label}: no foreign directory created`);
      assert.equal(foreignFileExists, false, `${scenario.label}: no foreign file created`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
