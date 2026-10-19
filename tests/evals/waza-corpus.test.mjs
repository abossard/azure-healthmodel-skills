import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";

import { loadSourceCases, buildScenarioPlans } from "./scenarios.mjs";
import { ALWAYS_ON_CASE_IDS, loadWorkflowBenchmark } from "./workflow-suite.mjs";

const WAZA_ROOT = path.resolve("tests/evals/waza");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
  assert.ok(match, "rubric must include frontmatter and body");
  const [, rawFrontmatter, body] = match;
  const fields = {};
  for (const line of rawFrontmatter.split("\n")) {
    const [key, ...rest] = line.split(":");
    fields[key.trim()] = rest.join(":").trim();
  }
  return { fields, body };
}

function parseRequirements(body) {
  return body
    .trim()
    .split("\n")
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, ""));
}

function parsePromptRequirements(taskYaml) {
  const sectionMatch = taskYaml.match(
    /- name:\s+expectation-rubric[\s\S]*?config:\n\s+prompt:\s+\|\n([\s\S]*?)(?:\n\s*-\s+name:|\n(?:tags:)|$)/
  );
  assert.ok(sectionMatch, "missing expectation-rubric config.prompt block");
  const promptBlock = sectionMatch[1]
    .split("\n")
    .map((line) => line.replace(/^\s{8}/, ""))
    .join("\n");
  return parseRequirements(promptBlock);
}

function assertPromptRubricParity(taskYaml, rubricRequirements, label) {
  const promptRequirements = parsePromptRequirements(taskYaml);
  assert.equal(
    promptRequirements.length,
    rubricRequirements.length,
    `requirement count mismatch between prompt and rubric for ${label}`
  );
  assert.deepEqual(
    promptRequirements,
    rubricRequirements,
    `requirement text/order mismatch between prompt and rubric for ${label}`
  );
}

function assertUniqueTaskIds(entries) {
  const ids = entries.map((entry) => entry.taskId);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, "duplicate task IDs in blocked manifest");
}

test("corpus contract preserves source census and expands to per-variant native task mapping", async () => {
  const [{ cases }, benchmark] = await Promise.all([loadSourceCases(), loadWorkflowBenchmark()]);
  const plans = await buildScenarioPlans(cases);
  const [sourceManifestRaw, fixtureManifestRaw, blockedManifestRaw] = await Promise.all([
    readFile(path.join(WAZA_ROOT, "manifests", "source-to-native.manifest.json"), "utf8"),
    readFile(path.join(WAZA_ROOT, "fixtures", "scenario-fixtures.manifest.json"), "utf8"),
    readFile(path.join(WAZA_ROOT, "manifests", "blocked.manifest.json"), "utf8"),
  ]);

  const sourceManifest = JSON.parse(sourceManifestRaw);
  const fixtureManifest = JSON.parse(fixtureManifestRaw);
  const blockedManifest = JSON.parse(blockedManifestRaw);

  assert.equal(sourceManifest.wazaVersionTarget, "0.38.10");
  assert.equal(sourceManifest.totals.sourceIdCount, 57);
  assert.equal(sourceManifest.totals.legacyCaseCount, 52);
  assert.equal(sourceManifest.totals.workflowCaseCount, ALWAYS_ON_CASE_IDS.length);
  assert.equal(sourceManifest.totals.legacyExpectationCount, 104);
  assert.equal(sourceManifest.totals.legacyVariantCount, 72);
  assert.equal(sourceManifest.totals.legacyTurnCount, 81);
  assert.equal(sourceManifest.totals.nativeTaskCount, 77);
  assert.equal(sourceManifest.totals.blockedTaskCount, 77);

  assert.equal(fixtureManifest.source.legacyCaseCount, 52);
  assert.equal(fixtureManifest.source.legacyExpectationCount, 104);
  assert.equal(fixtureManifest.source.variantCount, 72);
  assert.equal(fixtureManifest.source.turnCount, 81);
  assert.equal(fixtureManifest.source.workflowCaseCount, ALWAYS_ON_CASE_IDS.length);

  assert.ok(Array.isArray(blockedManifest.blockedTasks));
  assert.equal(blockedManifest.blockedTasks.length, 77);
  assertUniqueTaskIds(blockedManifest.blockedTasks);

  const sourceById = new Map(sourceManifest.sourceToVariantTasks.map((entry) => [entry.sourceId, entry]));
  for (const sourceCase of cases) {
    const mapping = sourceById.get(sourceCase.name);
    assert.ok(mapping, `missing mapping for source case ${sourceCase.name}`);
    assert.equal(mapping.expectedCount, sourceCase.expected.length, `expectation count mismatch for ${sourceCase.name}`);
    assert.equal(mapping.variantTaskCount, plans[sourceCase.name].variants.length, `variant count mismatch for ${sourceCase.name}`);
  }
  for (const workflowId of ALWAYS_ON_CASE_IDS) {
    const mapping = sourceById.get(workflowId);
    assert.ok(mapping, `missing mapping for workflow case ${workflowId}`);
    const expectedCount = benchmark.caseMap[workflowId].mandatoryChecks.length + benchmark.benchmark.commonMandatoryChecks.length;
    assert.equal(mapping.expectedCount, expectedCount);
    assert.equal(mapping.variantTaskCount, 1);
  }
});

test("variant tasks keep rubric fidelity and materialized fixture bytes", async () => {
  const [{ cases }, fixtureManifestRaw, sourceManifestRaw] = await Promise.all([
    loadSourceCases(),
    readFile(path.join(WAZA_ROOT, "fixtures", "scenario-fixtures.manifest.json"), "utf8"),
    readFile(path.join(WAZA_ROOT, "manifests", "source-to-native.manifest.json"), "utf8"),
  ]);
  const fixtureManifest = JSON.parse(fixtureManifestRaw);
  const sourceManifest = JSON.parse(sourceManifestRaw);
  const sourceById = new Map(cases.map((entry) => [entry.name, entry]));

  for (const mapping of sourceManifest.sourceToVariantTasks) {
    const rubricPath = path.resolve(mapping.rubricPath);
    const rubricRaw = await readFile(rubricPath, "utf8");
    const { fields, body } = parseFrontmatter(rubricRaw);
    const requirements = parseRequirements(body);
    assert.equal(fields.scale, "pass-fail");
    assert.match(fields.version, /^\d+\.\d+\.\d+$/);

    if (sourceById.has(mapping.sourceId)) {
      assert.deepEqual(requirements, sourceById.get(mapping.sourceId).expected, `rubric text drift for ${mapping.sourceId}`);
    }

    const contract = fixtureManifest.sourceVariantContract[mapping.sourceId];
    assert.ok(contract, `missing variant contract for ${mapping.sourceId}`);
    assert.deepEqual(contract.variantTaskIds, mapping.variantTaskIds);

    for (const variant of contract.variants) {
      const taskPath = path.join(WAZA_ROOT, "tasks", `${variant.taskId}.yaml`);
      const taskRaw = await readFile(taskPath, "utf8");
      assert.match(taskRaw, /^id:\s+/m);
      assert.match(taskRaw, /^name:\s+/m);
      assert.match(taskRaw, /^enabled:\s+false$/m);
      assert.match(taskRaw, /type:\s+skill_invocation/);
      assert.match(taskRaw, /type:\s+prompt/);
      assert.match(taskRaw, /config:\n\s+prompt:/m);
      assert.match(taskRaw, new RegExp(`rubric:\\s+${mapping.rubricPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assertPromptRubricParity(taskRaw, requirements, variant.taskId);

      const contextMatch = taskRaw.match(/^context_dir:\s+(.+)$/m);
      assert.ok(contextMatch, `missing context_dir in ${variant.taskId}`);
      const contextDir = contextMatch[1].trim();
      const contextAbs = path.resolve(path.join(WAZA_ROOT, "tasks"), contextDir);

      for (const fileRef of variant.fileRefs) {
        const filePath = path.join(contextAbs, fileRef.path);
        await access(filePath);
        const content = await readFile(filePath, "utf8");
        assert.equal(sha256(content), fileRef.sha256, `fixture sha mismatch for ${variant.taskId}:${fileRef.path}`);
        assert.equal(Buffer.byteLength(content, "utf8"), fileRef.bytes, `fixture byte mismatch for ${variant.taskId}:${fileRef.path}`);
      }
    }
  }
});

test("prompt-rubric parity guard fails on in-memory requirement drift", async () => {
  const sourceManifestRaw = await readFile(path.join(WAZA_ROOT, "manifests", "source-to-native.manifest.json"), "utf8");
  const sourceManifest = JSON.parse(sourceManifestRaw);
  const mapping = sourceManifest.sourceToVariantTasks.find((entry) => entry.sourceId === "always-on-01");
  assert.ok(mapping, "missing always-on-01 mapping");

  const [taskRaw, rubricRaw] = await Promise.all([
    readFile(path.join(WAZA_ROOT, "tasks", `${mapping.variantTaskIds[0]}.yaml`), "utf8"),
    readFile(path.resolve(mapping.rubricPath), "utf8"),
  ]);
  const rubricRequirements = parseRequirements(parseFrontmatter(rubricRaw).body);
  assertPromptRubricParity(taskRaw, rubricRequirements, mapping.variantTaskIds[0]);

  const driftedTaskRaw = taskRaw.replace(
    /^(\s{8}1\.\s+).+$/m,
    "$1Drifted requirement text that no longer matches the canonical rubric."
  );
  assert.throws(
    () => assertPromptRubricParity(driftedTaskRaw, rubricRequirements, "drift-case"),
    /mismatch between prompt and rubric/
  );
});

test("blocked manifest keeps unsupported and safety reasons separate", async () => {
  const blockedRaw = await readFile(path.join(WAZA_ROOT, "manifests", "blocked.manifest.json"), "utf8");
  const blocked = JSON.parse(blockedRaw).blockedTasks;

  const privateWorkflow = blocked.filter((entry) => entry.sourceId.startsWith("always-on-"));
  assert.equal(privateWorkflow.length, 5);
  for (const entry of privateWorkflow) {
    assert.equal(entry.readiness, "unsupported");
    assert.ok(entry.readinessReasons.includes("blocked:private-workflow-capture-set-unavailable"));
    assert.equal(entry.safetyAdmission, "unproven");
    assert.equal(entry.safetyReason, "blocked:safety-admission-unproven");
  }

  const dependencyBlocked = blocked.filter((entry) => entry.sourceId.startsWith("c5-p"));
  assert.ok(dependencyBlocked.length > 0);
  for (const entry of dependencyBlocked) {
    assert.ok(entry.readinessReasons.includes("blocked:cross-case-dependency-requires-prior-artifact-state"));
    assert.equal(entry.safetyAdmission, "unproven");
  }

  const unsupportedByReadiness = blocked.filter((entry) => entry.readiness === "unsupported");
  assert.equal(unsupportedByReadiness.length, blocked.length);
  for (const entry of unsupportedByReadiness) {
    assert.equal(entry.safetyReason, "blocked:safety-admission-unproven");
    assert.ok(entry.readinessReasons.length >= 1);
  }
});

test("eval schema-facing shape keeps required stock fields and drops prior invalid fields", async () => {
  const evalRaw = await readFile(path.join(WAZA_ROOT, "eval.yaml"), "utf8");
  assert.match(evalRaw, /^name:\s+\S+/m);
  assert.match(evalRaw, /^skill:\s+\S+/m);
  assert.match(evalRaw, /^version:\s+"[^"]+"$/m);
  assert.match(evalRaw, /^metrics:\n(?:\s+-\s+name:.*\n\s+weight:.*\n\s+threshold:.*)/m);
  assert.match(evalRaw, /^tasks:\n\s+-\s+tasks\/\*\.yaml$/m);
  assert.match(evalRaw, /^\s*parallel:\s+false$/m);
  assert.doesNotMatch(evalRaw, /^required_skills:/m);

  const taskExample = await readFile(path.join(WAZA_ROOT, "tasks", "c4-h3--wrong-target-awaiting-choice.yaml"), "utf8");
  assert.match(taskExample, /^name:\s+/m);
  assert.doesNotMatch(taskExample, /^metadata:/m);
  assert.doesNotMatch(taskExample, /\bsha256:\b/);
  assert.doesNotMatch(taskExample, /\bbytes:\b/);
});
