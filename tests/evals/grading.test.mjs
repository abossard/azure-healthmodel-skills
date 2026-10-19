import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

import { loadCorpus, loadGraderPrompt } from "./corpus.mjs";
import { mkdtemp, mkdir, symlink, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTests, validateCreatorGrade, computeVariantGateResults, assertVariantGates } from "./assertions.mjs";
import { prepareScenario, readObservationFile, loadSourceCases } from "./scenarios.mjs";

function makeValidGrade(expected) {
  const expectations = expected.map((text, index) => ({
    text,
    passed: index % 2 === 0,
    evidence: `evidence-${index + 1}`,
  }));
  const passed = expectations.filter((entry) => entry.passed).length;
  const failed = expectations.length - passed;
  return {
    expectations,
    summary: {
      passed,
      failed,
      total: expectations.length,
      pass_rate: expectations.length === 0 ? 0 : passed / expectations.length,
    },
    claims: [{ claim: "synthetic claim", type: "factual", verified: true, evidence: "verified" }],
    user_notes_summary: { uncertainties: [], needs_review: [], workarounds: [] },
    eval_feedback: { suggestions: [], overall: "No suggestions, evals look solid" },
  };
}

test("loadCorpus preserves full source census and exact expectation count", async () => {
  const { agentCases, gradeCases, scenarioPlans, sourceManifest } = await loadCorpus();
  assert.equal(Object.keys(agentCases).length, 52);
  assert.equal(Object.keys(gradeCases).length, 52);
  assert.equal(Object.keys(scenarioPlans).length, 52);
  assert.equal(sourceManifest.sourceCaseCount, 52);
  assert.equal(sourceManifest.categoryCount, 18);
  assert.equal(sourceManifest.skillCount, 6);
  assert.equal(sourceManifest.expectedCount, 104);
});

test("loadCorpus enforces selector semantics and ordering constraints", async () => {
  await assert.rejects(() => loadCorpus({ caseIds: [] }), /caseIds cannot be empty/);
  await assert.rejects(() => loadCorpus({ caseIds: ["unknown-case"] }), /Unknown caseId/);
  await assert.rejects(() => loadCorpus({ caseIds: ["intake-confirmed", "intake-confirmed"] }), /Duplicate case selection/);
  await assert.rejects(() => loadCorpus({ caseIds: ["c5-p2"] }), /requires c5-p1/);
});

async function createAlwaysOnWorkflowContext() {
  const root = await mkdtemp(path.join(os.tmpdir(), "always-on-workflow-"));
  const entries = [];
  for (const caseId of ["always-on-01", "always-on-02", "always-on-03", "always-on-04", "always-on-05"]) {
    const relative = `files/${caseId}.json`;
    const content = `${JSON.stringify({ caseId, status: "ok" }, null, 2)}\n`;
    await mkdir(path.join(root, "files"), { recursive: true });
    await writeFile(path.join(root, relative), content, "utf8");
    entries.push({
      path: relative,
      sha256: createHash("sha256").update(content).digest("hex"),
      kind: "capture",
      visibility: "agent",
      caseIds: [caseId],
    });
  }
  const graderContent = "{\"role\":\"grader\"}\n";
  await writeFile(path.join(root, "files", "grader.json"), graderContent, "utf8");
  entries.push({
    path: "files/grader.json",
    sha256: createHash("sha256").update(graderContent).digest("hex"),
    kind: "schema",
    visibility: "grader",
    caseIds: ["*"],
  });

  const case04Targets = [
    "/subscriptions/6fc552c5-06b6-43d7-ac70-2f1eda1be033/resourceGroups/rg-alwaysonn-global/providers/Microsoft.Resources/deployments/deploy-hm-darkux",
    "/subscriptions/6fc552c5-06b6-43d7-ac70-2f1eda1be033/resourceGroups/rg-alwaysonn-global/providers/Microsoft.CloudHealth/healthmodels/hm-darkux",
  ];
  const case04Operations = ["deployment.operation.group.list", "model.readback.get"];
  const deploymentOpsPath = "files/always-on-04-darkux-deployment-operations.json";
  const modelReadbackPath = "files/always-on-04-darkux-model-readback.json";
  const deploymentOpsContent = `${JSON.stringify({ result: [] }, null, 2)}\n`;
  const modelReadbackContent = `${JSON.stringify({
    result: { id: case04Targets[1], provisioningState: "Succeeded", type: "microsoft.cloudhealth/healthmodels" },
  }, null, 2)}\n`;
  await writeFile(path.join(root, deploymentOpsPath), deploymentOpsContent, "utf8");
  await writeFile(path.join(root, modelReadbackPath), modelReadbackContent, "utf8");
  const deploymentOpsSha = createHash("sha256").update(deploymentOpsContent).digest("hex");
  const modelReadbackSha = createHash("sha256").update(modelReadbackContent).digest("hex");
  entries.push({
    path: deploymentOpsPath,
    sha256: deploymentOpsSha,
    kind: "capture",
    visibility: "agent",
    caseIds: ["always-on-04"],
  });
  entries.push({
    path: modelReadbackPath,
    sha256: modelReadbackSha,
    kind: "capture",
    visibility: "agent",
    caseIds: ["always-on-04"],
  });

  const reviewPath = "files/reviews/always-on-04-darkux-benchmark-rehearsal-review.json";
  const reviewContent = `${JSON.stringify(
    {
      approvedPackagePath: "files/packages/darkux/change-a",
      approvedOperations: case04Operations,
      approvedTargets: case04Targets,
    },
    null,
    2
  )}\n`;
  await mkdir(path.join(root, "files", "reviews"), { recursive: true });
  await writeFile(path.join(root, reviewPath), reviewContent, "utf8");
  entries.push({
    path: reviewPath,
    sha256: createHash("sha256").update(reviewContent).digest("hex"),
    kind: "review",
    visibility: "agent",
    caseIds: ["always-on-04"],
  });

  const packageRoot = path.join(root, "files/packages/darkux/change-a");
  await mkdir(packageRoot, { recursive: true });
  const packageJsonContent = `${JSON.stringify({ operations: case04Operations, targets: case04Targets }, null, 2)}\n`;
  const parametersContent = `${JSON.stringify({ env: "test" }, null, 2)}\n`;
  await writeFile(path.join(packageRoot, "package.json"), packageJsonContent, "utf8");
  await writeFile(path.join(packageRoot, "parameters.json"), parametersContent, "utf8");
  const materialContent = `${JSON.stringify(
    {
      generatedFrom: {
        deploymentOperationsPath: deploymentOpsPath,
        deploymentOperationsSha256: deploymentOpsSha,
        modelReadbackPath,
        modelReadbackSha256: modelReadbackSha,
      },
      historicalEvidenceOnly: true,
      limits: { noDeploymentWriteClaim: true },
    },
    null,
    2
  )}\n`;
  await writeFile(path.join(packageRoot, "material-recorded-ops.json"), materialContent, "utf8");
  for (const [relativePath, content] of [
    ["files/packages/darkux/change-a/package.json", packageJsonContent],
    ["files/packages/darkux/change-a/parameters.json", parametersContent],
    ["files/packages/darkux/change-a/material-recorded-ops.json", materialContent],
  ]) {
    entries.push({
      path: relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      kind: "package",
      visibility: "agent",
      caseIds: ["always-on-04"],
    });
  }

  const oraclePath = "files/private/darkux-approval-oracle.json";
  const oracleContent = `${JSON.stringify(
    {
      approvedPackagePath: "files/packages/darkux/change-a",
      reviewRecord: reviewPath,
    },
    null,
    2
  )}\n`;
  await mkdir(path.join(root, "files", "private"), { recursive: true });
  await writeFile(path.join(root, oraclePath), oracleContent, "utf8");
  entries.push({
    path: oraclePath,
    sha256: createHash("sha256").update(oracleContent).digest("hex"),
    kind: "schema",
    visibility: "host",
    caseIds: ["always-on-04"],
  });

  const manifest = {
    schemaVersion: 1,
    id: "always-on-test-manifest",
    lockedAt: "2026-10-18T08:00:00.000Z",
    approvedContractSha256: "4d8d1118e676cd103854743deb9ad30be0f48112ab2a2623c5f38eed60c29062",
    benchmarkSha256: "590a902739a208f4f8d8f4a1bfdac125706025d86f0d4a5784a84adf413d7bfc",
    scope: {
      subscriptionId: "6fc552c5-06b6-43d7-ac70-2f1eda1be033",
      resourceGroups: ["rg-alwaysonn-global"],
    },
    entries,
  };
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, raw, "utf8");
  return {
    captureSetPath: manifestPath,
    captureManifestSha256: createHash("sha256").update(raw).digest("hex"),
    validationMode: "recorded",
    liveValidationId: null,
    liveReceiptRoot: null,
  };
}

test("loadCorpus always-on-five-v1 returns five locked cases and keeps capabilities grade-side", async () => {
  const workflowContext = await createAlwaysOnWorkflowContext();
  const { agentCases, gradeCases, sourceManifest } = await loadCorpus({
    suiteId: "always-on-five-v1",
    workflowContext,
  });
  assert.deepEqual(Object.keys(agentCases), [
    "always-on-01",
    "always-on-02",
    "always-on-03",
    "always-on-04",
    "always-on-05",
  ]);
  assert.equal(sourceManifest.suiteId, "always-on-five-v1");
  assert.equal(sourceManifest.expectedCount, 27);
  assert.equal(sourceManifest.commonCheckCount, 5);
  assert.equal(Object.keys(agentCases["always-on-01"]).includes("skill"), false);
  assert.deepEqual(gradeCases["always-on-01"].expectedCapabilities.required, ["healthmodel-plan"]);
  assert.equal(gradeCases["always-on-05"].expected.length, 10);
});

test("loadCorpus always-on-five-v1 rejects unknown suite id and missing context", async () => {
  await assert.rejects(() => loadCorpus({ suiteId: "unknown-suite" }), /Unknown suiteId/);
  await assert.rejects(() => loadCorpus({ suiteId: "always-on-five-v1" }), /workflowContext is required/);
});

test("buildTests uses capability gate for always-on suite and enforces strict skillCalls evidence", async () => {
  const workflowContext = await createAlwaysOnWorkflowContext();
  const corpus = await loadCorpus({
    suiteId: "always-on-five-v1",
    caseIds: ["always-on-01"],
    workflowContext,
  });
  const tests = buildTests(corpus);
  const capabilityGate = tests[0].assert.find((entry) => entry.description === "gate:capabilitiesUsed");
  assert.ok(capabilityGate);
  const fail = capabilityGate.value({}, { providerResponse: { metadata: { skillCalls: [] } } });
  assert.equal(fail.pass, false);
  const noRoot = capabilityGate.value(
    {},
    {
      providerResponse: {
        metadata: {
          skillCalls: [
            {
              name: "healthmodel-plan",
              source: "project",
              path: "/tmp/snapshot/healthmodel-plan/SKILL.md",
              contentSha256: "a".repeat(64),
              id: "ev-1",
              timestamp: "2026-10-18T08:00:00.000Z",
              sessionId: "s-1",
              candidateSnapshotId: "c-1",
            },
          ],
        },
      },
    }
  );
  assert.equal(noRoot.pass, false);
  const nonSnapshot = capabilityGate.value(
    {},
    {
      providerResponse: {
        metadata: {
          runtime: { skillSnapshotRoot: "/tmp/snapshot" },
          skillCalls: [
            {
              name: "healthmodel-plan",
              source: "catalog",
              path: "/tmp/snapshot/healthmodel-plan/SKILL.md",
              contentSha256: "a".repeat(64),
              id: "ev-1",
              timestamp: "2026-10-18T08:00:00.000Z",
              sessionId: "s-1",
              candidateSnapshotId: "c-1",
            },
          ],
        },
      },
    }
  );
  assert.equal(nonSnapshot.pass, false);
  const badPath = capabilityGate.value(
    {},
    {
      providerResponse: {
        metadata: {
          runtime: { skillSnapshotRoot: "/tmp/snapshot" },
          skillCalls: [
            {
              name: "healthmodel-plan",
              source: "project",
              path: "/outside/healthmodel-plan/SKILL.md",
              contentSha256: "a".repeat(64),
              id: "ev-1",
              timestamp: "2026-10-18T08:00:00.000Z",
              sessionId: "s-1",
              candidateSnapshotId: "c-1",
            },
          ],
        },
      },
    }
  );
  assert.equal(badPath.pass, false);
  const badHash = capabilityGate.value(
    {},
    {
      providerResponse: {
        metadata: {
          runtime: { skillSnapshotRoot: "/tmp/snapshot" },
          skillCalls: [
            {
              name: "healthmodel-plan",
              source: "project",
              path: "/tmp/snapshot/healthmodel-plan/SKILL.md",
              contentSha256: "short",
              id: "ev-1",
              timestamp: "2026-10-18T08:00:00.000Z",
              sessionId: "s-1",
              candidateSnapshotId: "c-1",
            },
          ],
        },
      },
    }
  );
  assert.equal(badHash.pass, false);
  const rootBypass = capabilityGate.value(
    {},
    {
      providerResponse: {
        metadata: {
          runtime: { skillSnapshotRoot: "/tmp/snap" },
          skillCalls: [
            {
              name: "healthmodel-plan",
              source: "project",
              path: "/tmp/snapshot/healthmodel-plan/SKILL.md",
              contentSha256: "a".repeat(64),
              id: "ev-1",
              timestamp: "2026-10-18T08:00:00.000Z",
              sessionId: "s-1",
              candidateSnapshotId: "c-1",
            },
          ],
        },
      },
    }
  );
  assert.equal(rootBypass.pass, false);
  const missingAnchors = capabilityGate.value(
    {},
    {
      providerResponse: {
        metadata: {
          runtime: { skillSnapshotRoot: "/tmp/snapshot" },
          skillCalls: [
            {
              name: "healthmodel-plan",
              source: "project",
              path: "/tmp/snapshot/healthmodel-plan/SKILL.md",
              contentSha256: "a".repeat(64),
            },
          ],
        },
      },
    }
  );
  assert.equal(missingAnchors.pass, false);
  const mismatchedAnchors = capabilityGate.value(
    {},
    {
      providerResponse: {
        metadata: {
          runtime: {
            skillSnapshotRoot: "/tmp/snapshot",
            sessionId: "runtime-session",
            candidateSnapshotId: "runtime-candidate",
          },
          skillCalls: [
            {
              name: "healthmodel-plan",
              source: "project",
              path: "/tmp/snapshot/healthmodel-plan/SKILL.md",
              contentSha256: "a".repeat(64),
              id: "ev-1",
              timestamp: "2026-10-18T08:00:00.000Z",
              sessionId: "s-1",
              candidateSnapshotId: "c-1",
            },
          ],
        },
      },
    }
  );
  assert.equal(mismatchedAnchors.pass, false);
  const pass = capabilityGate.value(
    {},
    {
      providerResponse: {
        metadata: {
          runtime: { skillSnapshotRoot: "/tmp/snapshot" },
          skillCalls: [
            {
              name: "healthmodel-plan",
              source: "project",
              path: "/tmp/snapshot/healthmodel-plan/SKILL.md",
              contentSha256: "a".repeat(64),
              id: "ev-1",
              timestamp: "2026-10-18T08:00:00.000Z",
              sessionId: "s-1",
              candidateSnapshotId: "c-1",
            },
          ],
        },
      },
    }
  );
  assert.equal(pass.pass, true);
});

for (const { name, overrides, pass } of [
  { name: "SDK id", overrides: {}, pass: true },
  { name: "missing id", overrides: { id: undefined }, pass: false },
  { name: "synthetic eventId only", overrides: { id: undefined, eventId: "synthetic-event" }, pass: false },
  {
    name: "different capability",
    overrides: { name: "healthmodel-observe", path: "/tmp/snapshot/healthmodel-observe/SKILL.md" },
    pass: false,
  },
]) {
  test(`native capability gate uses canonical event anchors: ${name}`, () => {
    const [scenario] = buildTests({
      agentCases: { "always-on-01": { task: "Save a health-definition brief." } },
      gradeCases: {
        "always-on-01": { expected: [], expectedCapabilities: { required: ["healthmodel-plan"] } },
      },
    });
    const gate = scenario.assert.find((entry) => entry.description === "gate:capabilitiesUsed");
    const result = gate.value({}, {
      providerResponse: {
        metadata: {
          runtime: {
            skillSnapshotRoot: "/tmp/snapshot",
            sessionId: "native-session",
            candidateSnapshotId: "run:always-on-01:default",
          },
          skillCalls: [{
            name: "healthmodel-plan",
            path: "/tmp/snapshot/healthmodel-plan/SKILL.md",
            source: "custom",
            id: "10bdd4fa-7a69-41c6-bd5e-1e4470ad8125",
            parentId: null,
            timestamp: "2026-10-18T09:44:29.713Z",
            agentId: null,
            sessionId: "native-session",
            candidateSnapshotId: "run:always-on-01:default",
            contentSha256: "a".repeat(64),
            ...overrides,
          }],
        },
      },
    });
    assert.equal(result.pass, pass, result.reason);
    if (name === "different capability") assert.match(result.reason, /Missing required invoked capability/);
  });
}

test("agentCases expose canonical keys only", async () => {
  const { agentCases } = await loadCorpus({ caseIds: ["intake-confirmed"] });
  const entry = agentCases["intake-confirmed"];
  assert.deepEqual(Object.keys(entry).sort(), ["id", "inputFiles", "observations", "skill", "task"]);
});

test("prepareScenario returns explicit c4-h2 ordered turns", async () => {
  const scenario = await prepareScenario("c4-h2", "ordered-refusal-scope-correction-acceptance");
  assert.equal(scenario.status, "ready");
  assert.equal(scenario.turns.length, 5);
  assert.equal(scenario.turns[1].text, "not yet");
  assert.match(scenario.turns[2].text, /scope-only/i);
  assert.match(scenario.turns[3].text, /correction/i);
  assert.match(scenario.turns[4].text, /accept/i);
});

test("prepareScenario avoids approval leakage in unapproved cases", async () => {
  const scenario = await prepareScenario("c4-h1", "missing-scope-then-ambiguous-rg");
  assert.equal(scenario.status, "ready");
  const filePaths = scenario.files.map((entry) => entry.path);
  assert.equal(filePaths.some((path) => path.includes("approval")), false);
});

test("prepareScenario covers c4-h4 and c5-p3 success+denial variants", async () => {
  const c4Base = await prepareScenario("c4-h4", "missing-tools-offline-context");
  assert.equal(c4Base.permissionPolicy.operationPermissions.allowCaptureWrite, true);

  const c4Denied = await prepareScenario("c4-h4", "no-writable-files-repeat-h2");
  assert.equal(c4Denied.deniedOperations.length > 0, true);
  assert.equal(c4Denied.deniedOperations[0].operationClass, "capture");

  const p3Base = await prepareScenario("c5-p3", "successful-captures-and-denied-continuations");
  assert.equal(p3Base.permissionPolicy.operationPermissions.allowCaptureWrite, true);
  assert.equal(p3Base.deniedOperations.length, 0);

  const p3CaptureDenied = await prepareScenario("c5-p3", "deny-capture-write");
  assert.equal(p3CaptureDenied.deniedOperations[0].operationClass, "capture");

  const p3NoteDenied = await prepareScenario("c5-p3", "deny-evidence-note-write");
  assert.equal(p3NoteDenied.deniedOperations[0].operationClass, "note");
});

test("prepareScenario enforces strict c5-p2 dependency artifact provenance", async () => {
  const blocked = await prepareScenario("c5-p2", "mismatch-cloud-tenant");
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.blockingReason, /c5-p1/);

  const malformed = await prepareScenario("c5-p2", "mismatch-cloud-tenant", {
    "c5-p1": { status: "graded-pass", artifactManifest: [{ path: "x", sha256: "abc", bytes: 1, content: "{}" }] },
  });
  assert.equal(malformed.status, "blocked");

  const badDigest = await prepareScenario("c5-p2", "mismatch-cloud-tenant", {
    "c5-p1": {
      status: "graded-fail",
      artifactManifest: [
        {
          path: "captures/p1-observation.json",
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          bytes: 11,
          content: "{\"ok\":true}",
          provenance: "p1-run-ledger-entry",
        },
      ],
    },
  });
  assert.equal(badDigest.status, "blocked");

  const validContent = "{\"ok\":true}";
  const validHash = "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93";
  const validBytes = Buffer.byteLength(validContent, "utf8");

  const ready = await prepareScenario("c5-p2", "mismatch-cloud-tenant", {
    "c5-p1": {
      status: "graded-fail",
      artifactManifest: [
        {
          path: "captures/p1-observation.json",
          sha256: validHash,
          bytes: validBytes,
          content: validContent,
          provenance: "p1-run-ledger-entry",
        },
      ],
    },
  });
  assert.equal(ready.status, "ready");
});

test("prepareScenario c5-p4 includes private and unsafe consumer variants", async () => {
  const privateVariant = await prepareScenario("c5-p4", "protected-outside-git-consumer");
  assert.equal(privateVariant.permissionPolicy.privacyGuards.requireOutsideGitConsumer, true);
  assert.equal(privateVariant.consumerKind, "private-outside-git");
  assert.equal(privateVariant.permissionPolicy.consumerKind, "private-outside-git");

  const unsafeVariant = await prepareScenario("c5-p4", "unsafe-consumer-pauses");
  assert.equal(unsafeVariant.deniedOperations.length, 0);
  assert.equal(unsafeVariant.consumerKind, "inside-git-candidate");
  assert.equal(unsafeVariant.consumerCandidate.kind, "inside-git-candidate");
  assert.equal(unsafeVariant.gateSpec.consumerInspectionExpected, "inside-git-candidate");
});

test("loadGraderPrompt returns vendored grader plus transport and hash verification", async () => {
  const grader = await loadGraderPrompt();
  assert.equal(typeof grader.prompt, "string");
  assert.equal(typeof grader.transport, "string");
  assert.equal(grader.promptSha256.length, 64);
  assert.equal(grader.transport.includes("untrusted"), true);
});

test("validateCreatorGrade rejects payloads with error key and summary mismatch", async () => {
  const { gradeCases } = await loadCorpus({ caseIds: ["intake-confirmed"] });
  const expected = gradeCases["intake-confirmed"].expected;
  const grade = makeValidGrade(expected);

  const withError = structuredClone(grade);
  withError.error = { kind: "x", message: "boom" };
  assert.throws(() => validateCreatorGrade(withError, expected), /error key/);

  const withSummaryMismatch = structuredClone(grade);
  withSummaryMismatch.summary.total += 1;
  assert.throws(() => validateCreatorGrade(withSummaryMismatch, expected), /summary.total mismatch/);
});

test("buildTests emits promptfoo-native assert array with additive gates", async () => {
  const corpus = await loadCorpus({ caseIds: ["intake-confirmed"] });
  const tests = buildTests(corpus);
  assert.equal(tests.length, 1);
  const one = tests[0];
  assert.deepEqual(Object.keys(one.vars).sort(), ["caseId", "task"]);
  assert.ok(Array.isArray(one.assert));
  assert.equal(one.assert.length, corpus.gradeCases["intake-confirmed"].expected.length + 3);
  const falseCase = one.assert.find((entry) => entry.description.includes("expectation[1]"));
  assert.equal(["function", "string"].includes(typeof falseCase.value), true);
});

test("buildTests expectation assertion returns failing verdict without fabrication", async () => {
  const corpus = await loadCorpus({ caseIds: ["intake-confirmed"] });
  const tests = buildTests(corpus);
  const expectationAssertion = tests[0].assert.find((entry) => entry.description.startsWith("expectation[1]:"));
  const expected = corpus.gradeCases["intake-confirmed"].expected;
  const grade = makeValidGrade(expected);
  grade.expectations[0].passed = false;
  grade.expectations[0].evidence = "explicit failing evidence";
  grade.summary.passed -= 1;
  grade.summary.failed += 1;
  grade.summary.pass_rate = grade.summary.passed / grade.summary.total;

  const output = expectationAssertion.value({}, { providerResponse: { metadata: { creatorGrade: grade } } });
  assert.equal(output.pass, false);
  assert.equal(output.score, 0);
  assert.equal(output.reason, "explicit failing evidence");
});

test("buildTests expectation assertion fails closed when creatorGrade missing", async () => {
  const corpus = await loadCorpus({ caseIds: ["intake-confirmed"] });
  const tests = buildTests(corpus);
  const expectationAssertion = tests[0].assert.find((entry) => entry.description.startsWith("expectation[1]:"));
  const output = expectationAssertion.value({}, { providerResponse: { metadata: {} } });
  assert.equal(output.pass, false);
  assert.equal(output.score, 0);
  assert.match(output.reason, /creatorGrade missing/i);
});

// ---------- per-variant gate, fixture and fidelity regressions ----------
const GATE = "gate:artifactAndAttempts";

function patternToPath(pattern) {
  return pattern.replace("**/*.bicep", "outputs/main.bicep").replace("/**", "/x.json").replace("**", "x");
}

function goodMetadata(plan) {
  const artifactManifest = [];
  const attempts = [];
  const consumerInspection = {};
  for (const variant of plan.variants) {
    const spec = variant.gateSpec;
    const add = (entry) => artifactManifest.push({ variantId: variant.id, ...entry });
    spec.preservedArtifacts.forEach((entry) => add({ ...entry }));
    spec.changedArtifacts.forEach((entry) => add({ path: entry.path, sha256: "f".repeat(64), bytes: 5 }));
    spec.requiredArtifacts.forEach((pattern) => {
      const target = patternToPath(pattern);
      if (!artifactManifest.some((e) => e.variantId === variant.id && e.path === target)) add({ path: target, sha256: "e".repeat(64), bytes: 7 });
    });
    spec.requiredDeniedAttemptClasses.forEach((cls) => attempts.push({ variantId: variant.id, operationClass: cls, operation: `${cls}.write`, status: "denied" }));
    const kind = spec.consumerInspectionExpected;
    consumerInspection[variant.id] = { kind, insideGit: kind === "inside-git-candidate", verified: kind !== "unverified-consumer" };
  }
  return { artifactManifest, attempts, consumerInspection, variantsExecuted: plan.variants.map((v) => v.id) };
}

async function gateFor(caseId) {
  const corpus = await loadCorpus({ caseIds: caseId === "c5-p2" ? ["c5-p1", caseId] : [caseId] });
  const test = buildTests(corpus).find((entry) => entry.vars.caseId === caseId);
  const gate = test.assert.find((entry) => entry.description === GATE);
  const plan = corpus.scenarioPlans[caseId];
  return { plan, run: (metadata) => gate.value({}, { providerResponse: { metadata } }) };
}

const ALL_CASE_IDS = (await loadSourceCases()).cases.map((entry) => entry.name);

for (const caseId of ALL_CASE_IDS) {
  test(`gate: ${caseId} passes the correct per-variant evidence and fails each mutant`, async () => {
    const { plan, run } = await gateFor(caseId);
    const good = goodMetadata(plan);
    const verdict = run(good);
    assert.equal(verdict.pass, true, verdict.reason);

    const mutants = [];
    mutants.push(["network", { ...good, attempts: [...good.attempts, { variantId: plan.variants[0].id, operationClass: "azure.network", operation: "azure.network", status: "completed" }] }]);
    mutants.push(["variant not executed", { ...good, variantsExecuted: good.variantsExecuted.slice(1) }]);
    mutants.push(["no inspection", { ...good, consumerInspection: {} }]);
    for (const variant of plan.variants) {
      const spec = variant.gateSpec;
      const own = (entry) => entry.variantId === variant.id;
      for (const pattern of spec.forbiddenArtifacts) {
        mutants.push([`forbidden ${pattern}@${variant.id}`, { ...good, artifactManifest: [...good.artifactManifest, { variantId: variant.id, path: patternToPath(pattern), sha256: "d".repeat(64), bytes: 3 }] }]);
      }
      for (const pattern of spec.forbiddenAttemptOperations) {
        mutants.push([`forbidden op ${pattern}@${variant.id}`, { ...good, attempts: [...good.attempts, { variantId: variant.id, operationClass: pattern, operation: `${pattern}.write`, status: "completed" }] }]);
      }
      for (const kept of spec.preservedArtifacts) {
        mutants.push([`preserved changed ${kept.path}@${variant.id}`, { ...good, artifactManifest: good.artifactManifest.map((e) => (own(e) && e.path === kept.path ? { ...e, sha256: "c".repeat(64) } : e)) }]);
        mutants.push([`preserved missing ${kept.path}@${variant.id}`, { ...good, artifactManifest: good.artifactManifest.filter((e) => !(own(e) && e.path === kept.path)) }]);
      }
      for (const seed of spec.changedArtifacts) {
        mutants.push([`seed-only ${seed.path}@${variant.id}`, { ...good, artifactManifest: good.artifactManifest.map((e) => (own(e) && e.path === seed.path ? { ...e, sha256: seed.notSha256 } : e)) }]);
      }
      for (const pattern of spec.requiredArtifacts) {
        const target = patternToPath(pattern);
        mutants.push([`required missing ${pattern}@${variant.id}`, { ...good, artifactManifest: good.artifactManifest.filter((e) => !(own(e) && e.path === target)) }]);
      }
      for (const cls of spec.requiredDeniedAttemptClasses) {
        mutants.push([`omitted denial ${cls}@${variant.id}`, { ...good, attempts: good.attempts.filter((e) => !(own(e) && e.operationClass === cls)) }]);
      }
      mutants.push([`wrong consumer@${variant.id}`, { ...good, consumerInspection: { ...good.consumerInspection, [variant.id]: { kind: "wrong-kind", insideGit: false, verified: true } } }]);
      // a variant's evidence cannot be satisfied by another variant's artifacts
      if (plan.variants.length > 1 && (spec.requiredArtifacts.length > 0 || spec.preservedArtifacts.length > 0)) {
        mutants.push([`cross-variant@${variant.id}`, { ...good, artifactManifest: good.artifactManifest.map((e) => (own(e) ? { ...e, variantId: "other" } : e)) }]);
      }
    }
    for (const [label, metadata] of mutants) {
      assert.equal(run(metadata).pass, false, `mutant should fail: ${label}`);
    }
  });
}

test("gate: named mutants for c4-h1, c5-p4 and c4-h3", async () => {
  const h1 = await gateFor("c4-h1");
  const h1Good = goodMetadata(h1.plan);
  const v = h1.plan.variants[0].id;
  assert.equal(h1.run({ ...h1Good, artifactManifest: [{ variantId: v, path: "outputs/main.bicep", sha256: "a".repeat(64), bytes: 1 }] }).pass, false);
  assert.equal(h1.run({ ...h1Good, attempts: [{ variantId: v, operationClass: "capture", operation: "capture.write", status: "completed" }] }).pass, false);

  const p4 = await gateFor("c5-p4");
  const wrong = p4.plan.variants.find((x) => x.id === "wrong-target-brief");
  const p4Good = goodMetadata(p4.plan);
  assert.equal(p4.run(p4Good).pass, true);
  assert.equal(p4.run({ ...p4Good, artifactManifest: p4Good.artifactManifest.map((e) => (e.variantId === wrong.id && e.path === ".healthmodel/brief.md" ? { ...e, sha256: "b".repeat(64), bytes: 9 } : e)) }).pass, false);

  const h3 = await gateFor("c4-h3");
  const h3Good = goodMetadata(h3.plan);
  assert.equal(h3.run({ ...h3Good, artifactManifest: [...h3Good.artifactManifest, { variantId: "same-target-update", path: "outputs/extra.bicep", sha256: "a".repeat(64), bytes: 1 }] }).pass, false);
});

test("skill gate accepts only the bare or plugin-namespaced skill and rejects foo:<skill>", async () => {
  const corpus = await loadCorpus({ caseIds: ["intake-confirmed"] });
  const gate = buildTests(corpus)[0].assert.find((entry) => entry.description === "gate:skillUsed");
  const skill = corpus.agentCases["intake-confirmed"].skill;
  const check = (name) => gate.value({}, { providerResponse: { metadata: { skillCalls: [{ name }] } } }).pass;
  assert.equal(check(skill), true);
  assert.equal(check(`azure-healthmodel-skills:${skill}`), true);
  assert.equal(check(`foo:${skill}`), false);
  assert.equal(check(`${skill}-extra`), false);
  assert.equal(check("healthmodel-signals"), false);
});

test("every staged public file and declared path lies within the variant's allowed read roots", async () => {
  const { scenarioPlans } = await loadCorpus();
  for (const plan of Object.values(scenarioPlans)) {
    for (const variant of plan.variants) {
      const roots = variant.permissionPolicy.localPathPermissions.allowedReadRoots;
      const paths = new Set();
      for (const entry of variant.files) {
        assert.equal(path.isAbsolute(entry.path) || entry.path.split("/").includes(".."), false, entry.path);
        assert.ok(roots.includes(entry.path.split("/")[0]), `${plan.caseId}/${variant.id}: ${entry.path} outside read roots`);
        assert.equal(paths.has(entry.path), false, `duplicate ${entry.path}`);
        paths.add(entry.path);
        assert.equal(entry.sha256.length, 64);
        assert.equal(Buffer.byteLength(entry.content, "utf8"), entry.bytes);
      }
    }
  }
});

test("fixtures contain no fabricated booleans, evidenceRef stubs, hidden answers or unrequested approvals", async () => {
  const { scenarioPlans } = await loadCorpus();
  for (const plan of Object.values(scenarioPlans)) {
    for (const variant of plan.variants) {
      for (const entry of variant.files) {
        const label = `${plan.caseId}/${variant.id}:${entry.path}`;
        assert.doesNotMatch(entry.content, /"[A-Za-z]*Provided"\s*:/, label);
        assert.doesNotMatch(entry.content, /evidenceRef|materializ/i, label);
        assert.doesNotMatch(entry.content, /approved\s*=\s*true/i, label);
        assert.doesNotMatch(entry.content, /"expected"\s*:|expectations\[/, label);
        if (entry.path.endsWith(".json")) {
          const parsed = JSON.parse(entry.content);
          assert.match(parsed["x-fixture"] ?? "", /synthetic/, label);
          assert.doesNotMatch(JSON.stringify(parsed), /:(true|false)[,}]\s*$/m, label);
        }
      }
    }
  }
});

test("history-utc fixture leaks no computed UTC answer and wrong-target bytes are staged", async () => {
  const utc = await prepareScenario("history-utc-and-pagination");
  assert.deepEqual(utc.files.map((e) => e.path), ["inputs/public-task.md"]);
  const wrong = await prepareScenario("c5-p4", "wrong-target-brief");
  const brief = wrong.files.find((e) => e.path === ".healthmodel/brief.md");
  assert.ok(brief);
  assert.deepEqual(wrong.gateSpec.preservedArtifacts.find((e) => e.path === ".healthmodel/brief.md").sha256, brief.sha256);
  const h3 = await prepareScenario("c4-h3", "same-target-update");
  assert.doesNotMatch(h3.files.find((e) => e.path === ".healthmodel/brief.md").content, /approved/i);
});

const PAYLOAD_CASES = [
  "incomplete-import", "writable-import-preservation", "changed-reviewed-artifacts", "history-repeat-and-carry-in",
  "absence-versus-read-failure", "c9-query-source-outcomes", "c9-bounded-removal", "c5-p1", "c5-p3",
];
for (const caseId of PAYLOAD_CASES) {
  test(`payload case ${caseId} stages concrete files beyond the public task`, async () => {
    const scenario = await prepareScenario(caseId);
    assert.ok(scenario.files.length > 1);
    assert.ok(scenario.files.every((entry) => entry.content.length > 40));
  });
}

test("changed-reviewed-artifacts approval record carries real hashes of the staged reviewed pair", async () => {
  const scenario = await prepareScenario("changed-reviewed-artifacts");
  const byPath = Object.fromEntries(scenario.files.map((e) => [e.path, e]));
  const approval = JSON.parse(byPath["inputs/reviewed/approval.json"].content);
  assert.equal(approval.approvedTemplate.sha256, byPath["inputs/reviewed/template.json"].sha256);
  assert.equal(approval.approvedParameters.sha256, byPath["inputs/reviewed/parameters.reviewed.json"].sha256);
  assert.notEqual(byPath["inputs/reviewed/parameters.current.json"].sha256, approval.approvedParameters.sha256);
});

test("per-variant consumer expectations cover private, inside-git and unverified", async () => {
  const { scenarioPlans } = await loadCorpus({ caseIds: ["c5-p4"] });
  const kinds = Object.fromEntries(scenarioPlans["c5-p4"].variants.map((v) => [v.id, v.gateSpec.consumerInspectionExpected]));
  assert.equal(kinds["protected-outside-git-consumer"], "private-outside-git");
  assert.equal(kinds["unsafe-consumer-pauses"], "inside-git-candidate");
  assert.equal(kinds["unverified-consumer-pauses"], "unverified-consumer");
});

test("exact 104 expectation texts match the unchanged source corpus", async () => {
  const { cases } = await loadSourceCases();
  const { gradeCases } = await loadCorpus();
  let total = 0;
  for (const source of cases) {
    assert.deepEqual(gradeCases[source.name].expected, source.expected);
    total += gradeCases[source.name].expected.length;
  }
  assert.equal(total, 104);
});

test("c5-p2 stages P1 saved bytes and does not require a P1 semantic pass", async () => {
  const content = "{\"saved\":true}";
  const manifest = [{ path: "captures/p1.json", sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content), content, provenance: "p1-run" }];
  for (const status of ["graded-pass", "graded-fail"]) {
    const ready = await prepareScenario("c5-p2", "mismatch-window-currentness", { "c5-p1": { status, artifactManifest: manifest } });
    assert.equal(ready.status, "ready");
    assert.ok(ready.files.some((e) => e.path === "captures/p1.json" && e.content === content));
    assert.ok(ready.gateSpec.preservedArtifacts.some((e) => e.path === "captures/p1.json"));
  }
});

const BAD_P1 = [
  ["wrong sha", (m) => ({ ...m, sha256: "0".repeat(64) })],
  ["wrong bytes", (m) => ({ ...m, bytes: m.bytes + 1 })],
  ["traversal path", (m) => ({ ...m, path: "captures/../x.json" })],
  ["absolute path", (m) => ({ ...m, path: "/etc/x.json" })],
  ["outside write roots", (m) => ({ ...m, path: "inputs/x.json" })],
  ["missing provenance", (m) => ({ ...m, provenance: "" })],
];
for (const [label, mutate] of BAD_P1) {
  test(`c5-p2 is blocked for falsified P1 manifest: ${label}`, async () => {
    const content = "{\"saved\":true}";
    const entry = { path: "captures/p1.json", sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content), content, provenance: "p1-run" };
    const blocked = await prepareScenario("c5-p2", "mismatch-cloud-tenant", { "c5-p1": { status: "graded-fail", artifactManifest: [mutate(entry)] } });
    assert.equal(blocked.status, "blocked");
  });
}

test("c5-p2 is blocked for duplicate P1 paths", async () => {
  const content = "{\"saved\":true}";
  const entry = { path: "captures/p1.json", sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content), content, provenance: "p1-run" };
  const blocked = await prepareScenario("c5-p2", "mismatch-cloud-tenant", { "c5-p1": { status: "x", artifactManifest: [entry, entry] } });
  assert.equal(blocked.status, "blocked");
});

test("observation references reject traversal, absolute, nested and symlinked names", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "obs-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "obs-out-"));
  await writeFile(path.join(outside, "secret.json"), "{}");
  await writeFile(path.join(dir, "ok.json"), "{}");
  await symlink(path.join(outside, "secret.json"), path.join(dir, "link.json"));
  await mkdir(path.join(dir, "sub"));
  for (const name of ["../x.json", "/abs.json", "sub/x.json", "a\\b.json", "link.json", ""]) {
    await assert.rejects(() => readObservationFile(name, dir), undefined, name);
  }
  assert.equal((await readObservationFile("ok.json", dir)).bytes, 2);
});

test("vendored grader and license stay byte-identical and the loaded hashes are the pinned ones", async () => {
  const grader = await loadGraderPrompt();
  assert.equal(grader.promptSha256, "57134da0c1a4eea33fbd74a1c9c44aa814f07d6bc64de303edb586f941e5d21a");
  assert.equal(grader.licenseSha256, "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362");
  const raw = await readFile(new URL("./vendor/skill-creator/grader.md", import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(raw).digest("hex"), grader.promptSha256);
  assert.match(grader.transport, /claims?/i);
  assert.match(grader.transport, /eval_feedback/);
  assert.match(grader.transport, /JSON/);
});

test("one failing expectation fails its case: no partial-score threshold", async () => {
  const corpus = await loadCorpus({ caseIds: ["intake-confirmed"] });
  const tests = buildTests(corpus);
  const expected = corpus.gradeCases["intake-confirmed"].expected;
  const grade = makeValidGrade(expected);
  grade.expectations.forEach((e) => { e.passed = true; });
  grade.expectations[1].passed = false;
  grade.summary = { passed: expected.length - 1, failed: 1, total: expected.length, pass_rate: (expected.length - 1) / expected.length };
  const results = tests[0].assert.filter((a) => a.description.startsWith("expectation[")).map((a) => a.value({}, { providerResponse: { metadata: { creatorGrade: grade } } }).pass);
  assert.deepEqual(results, expected.map((_, i) => i !== 1));
  assert.ok(tests[0].assert.every((a) => a.threshold === undefined));
});

test("c5-p1 prepared turns declare second-stage skill, new session and filesystem-only carry", async () => {
  const scenario = await prepareScenario("c5-p1");
  assert.equal(scenario.turns[0].skill, "healthmodel-observe");
  assert.deepEqual(
    { skill: scenario.turns[1].skill, session: scenario.turns[1].session, carry: scenario.turns[1].carry },
    { skill: "healthmodel-signals", session: "new", carry: "filesystem-only" }
  );
});

test("c5-p1 turn texts carry the source sentence, staged inventory and a concrete target/window question", async () => {
  const scenario = await prepareScenario("c5-p1");
  const [first, second] = scenario.turns;
  const stagedNative = scenario.files.map((e) => e.path).filter((p) => p.startsWith("inputs/native/"));
  assert.equal(stagedNative.length, 5);
  assert.ok(first.text.startsWith("In a verified private consumer, retain supplied fictional native resources, relationships, metric definitions, samples and log/query captures as observations without querying or judging health."));
  for (const p of stagedNative) assert.ok(first.text.includes(p), p);
  const samples = JSON.parse(scenario.files.find((e) => e.path === "inputs/native/metric-samples.json").content);
  assert.ok(second.text.includes(samples.request.path.split("/providers/Microsoft.Insights")[0]));
  assert.ok(second.text.includes(samples.request.query.timespan));
  assert.ok(second.text.includes(samples.request.query.metricnames));
  assert.doesNotMatch(second.text, /transcript|fresh (signals )?(session|task)|expected|"total"/i);
});

const PARITY = [
  ["forbidden outputs/**/*.bicep vs outputs/main.bicep", { forbiddenArtifacts: ["outputs/**/*.bicep"] }, { artifacts: [{ path: "outputs/main.bicep", sha256: "a", bytes: 1 }] }, "forbiddenArtifact:outputs/**/*.bicep", false],
  ["forbidden glob absent", { forbiddenArtifacts: ["outputs/**/*.bicep"] }, { artifacts: [{ path: "captures/a.json", sha256: "a", bytes: 1 }] }, "forbiddenArtifact:outputs/**/*.bicep", true],
  ["required glob", { requiredArtifacts: ["captures/**"] }, { artifacts: [{ path: "captures/a.json", sha256: "a", bytes: 1 }] }, "requiredArtifact:captures/**", true],
  ["preserved hash mismatch", { preservedArtifacts: [{ path: "x", sha256: "a", bytes: 1 }] }, { artifacts: [{ path: "x", sha256: "b", bytes: 1 }] }, "preservedArtifact:x", false],
  ["forbidden attempt", { forbiddenAttemptOperations: ["capture"] }, { attempts: [{ operationClass: "capture", status: "completed" }] }, "forbiddenAttemptOperation:capture", false],
  ["denied class missing", { requiredDeniedAttemptClasses: ["brief"] }, { attempts: [] }, "requiredDeniedAttemptClass:brief", false],
  ["seed unchanged", { changedArtifacts: [{ path: "b", notSha256: "s" }] }, { artifacts: [{ path: "b", sha256: "s", bytes: 1 }] }, "changedArtifact:b", false],
  ["consumer mismatch", { consumerInspectionExpected: "private-outside-git" }, { consumerInspection: { kind: "inside-git-candidate", insideGit: true, verified: true } }, "consumerInspection", false],
  [
    "produced artifact cannot reuse staged input hash",
    { requireProducedArtifact: true },
    { artifacts: [{ path: "inputs/a.txt", sha256: "a".repeat(64), bytes: 3 }, { path: "outputs/a.txt", sha256: "a".repeat(64), bytes: 3 }] },
    "producedArtifact",
    false,
  ],
  [
    "produced artifact requires non-empty bytes",
    { requireProducedArtifact: true },
    { artifacts: [{ path: "inputs/a.txt", sha256: "a".repeat(64), bytes: 3 }, { path: "outputs/b.txt", sha256: "b".repeat(64), bytes: 0 }] },
    "producedArtifact",
    false,
  ],
  [
    "produced artifact passes with different digest and non-empty bytes",
    { requireProducedArtifact: true },
    { artifacts: [{ path: "inputs/a.txt", sha256: "a".repeat(64), bytes: 3 }, { path: "outputs/b.txt", sha256: "b".repeat(64), bytes: 7 }] },
    "producedArtifact",
    true,
  ],
  [
    "produced artifact uses staged hash list from gate spec",
    { requireProducedArtifact: true, stagedInputHashes: ["c".repeat(64)] },
    { artifacts: [{ path: "outputs/copy.txt", sha256: "c".repeat(64), bytes: 12 }] },
    "producedArtifact",
    false,
  ],
];
for (const [label, spec, evidence, gateId, pass] of PARITY) {
  test(`shared gate calculation: ${label}`, () => {
    const results = computeVariantGateResults(spec, evidence);
    assert.equal(results[gateId].pass, pass);
    const verdict = assertVariantGates(
      { metadata: { artifactManifest: (evidence.artifacts ?? []).map((e) => ({ ...e, variantId: "v" })), attempts: (evidence.attempts ?? []).map((e) => ({ ...e, variantId: "v" })), consumerInspection: { v: evidence.consumerInspection }, variantsExecuted: ["v"] } },
      { v: spec }
    );
    assert.equal(verdict.pass, Object.values(results).every((g) => g.pass));
  });
}

for (const variantId of ["successful-captures-and-denied-continuations", "deny-capture-write", "deny-evidence-note-write"]) {
  test(`c5-p3 ${variantId}: one capture-task turn matching staged inventory, no host denial setup`, async () => {
    const scenario = await prepareScenario("c5-p3", variantId);
    assert.equal(scenario.turns.length, 1);
    const { text } = scenario.turns[0];
    const source = (await loadSourceCases()).cases.find((c) => c.name === "c5-p3").task;
    assert.ok(text.startsWith(source.split(/(?<=\.) /)[0]));
    for (const p of scenario.files.map((e) => e.path).filter((x) => x.startsWith("inputs/native/"))) assert.ok(text.includes(p), p);
    assert.ok(text.includes("captures/") && text.includes("notes/"));
    assert.doesNotMatch(text, /fresh narrow variants|deny|simulate|refus/i);
  });
}

test("c5-p1 first turn ends with the read-only inputs vs output-roots interface line", async () => {
  const scenario = await prepareScenario("c5-p1");
  assert.ok(scenario.turns[0].text.endsWith("Files under inputs/ are read-only. Retained observations may be written under captures/ (and notes under notes/)."));
  assert.doesNotMatch(scenario.turns[0].text, /must|ensure|succe/i);
});
