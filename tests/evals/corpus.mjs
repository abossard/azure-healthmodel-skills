import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildScenarioPlans, listRequiredCases, loadSourceCases } from "./scenarios.mjs";
import {
  ALWAYS_ON_CASE_IDS,
  ALWAYS_ON_SUITE_ID,
  APPROVED_CONTRACT_SHA256,
  BENCHMARK_FIXTURE_PATH,
  buildExpectedCapabilities,
  loadValidatedCaptureSet,
  loadWorkflowBenchmark,
  prepareWorkflowScenario,
} from "./workflow-suite.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VENDORED_GRADER_PATH = path.join(REPO_ROOT, "tests", "evals", "vendor", "skill-creator", "grader.md");
const VENDORED_LICENSE_PATH = path.join(REPO_ROOT, "tests", "evals", "vendor", "skill-creator", "LICENSE.txt");
const GRADER_TRANSPORT_PATH = path.join(REPO_ROOT, "tests", "evals", "prompts", "grader-transport.txt");
const EXPECTED_GRADER_SHA256 = "57134da0c1a4eea33fbd74a1c9c44aa814f07d6bc64de303edb586f941e5d21a";
const EXPECTED_LICENSE_SHA256 = "bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertUniqueCaseSelection(caseIds) {
  const seen = new Set();
  for (const caseId of caseIds) {
    if (seen.has(caseId)) {
      throw new Error(`Duplicate case selection: ${caseId}`);
    }
    seen.add(caseId);
  }
}

function assertSelectionSemantics(caseIds) {
  if (!Array.isArray(caseIds)) {
    return;
  }
  if (caseIds.length === 0) {
    throw new Error("caseIds cannot be empty.");
  }
}

function assertDependencyOrdering(caseIds) {
  if (!Array.isArray(caseIds)) {
    return;
  }
  const p2Index = caseIds.indexOf("c5-p2");
  if (p2Index === -1) {
    return;
  }
  const p1Index = caseIds.indexOf("c5-p1");
  if (p1Index === -1) {
    throw new Error("Selecting c5-p2 requires c5-p1 in caseIds or a runtime priorArtifacts dependency.");
  }
  if (p1Index > p2Index) {
    throw new Error("c5-p1 must appear before c5-p2 in caseIds.");
  }
}

function createLegacySourceManifest(sourceRaw, sourceCases, selectedCases) {
  const categories = new Set(sourceCases.map((entry) => entry.category));
  const skills = new Set(sourceCases.map((entry) => entry.skill));
  const expectedCount = sourceCases.reduce((acc, entry) => acc + entry.expected.length, 0);

  return {
    sourcePath: path.join("tests", "fixtures", "workflows", "cases.json"),
    sourceSha256: sha256(sourceRaw),
    sourceCaseCount: sourceCases.length,
    selectedCaseCount: selectedCases.length,
    selectedCaseIds: selectedCases.map((entry) => entry.name),
    categoryCount: categories.size,
    skillCount: skills.size,
    expectedCount,
    casesById: Object.fromEntries(
      sourceCases.map((entry) => [
        entry.name,
        {
          expectedCount: entry.expected.length,
          expectationStrings: [...entry.expected],
          category: entry.category,
          skill: entry.skill,
          taskSha256: sha256(entry.task),
        },
      ])
    ),
  };
}

function buildAgentCase(caseRecord, scenarioPlan, observationMap) {
  return {
    id: caseRecord.name,
    task: caseRecord.task,
    skill: caseRecord.skill,
    observations: Object.values(observationMap),
    inputFiles: [...new Set(scenarioPlan.variants.flatMap((variant) => variant.files.map((entry) => entry.path)))],
  };
}

function buildGradeCase(caseRecord, scenarioPlan) {
  return {
    id: caseRecord.name,
    expected: [...caseRecord.expected],
    expectedCount: caseRecord.expected.length,
    variantGateSpecs: Object.fromEntries(scenarioPlan.variants.map((variant) => [variant.id, variant.gateSpec])),
  };
}

function normalizeAlwaysOnCaseIds(caseIds) {
  if (caseIds === undefined) return [...ALWAYS_ON_CASE_IDS];
  if (!Array.isArray(caseIds) || caseIds.length === 0) {
    throw new Error("caseIds cannot be empty.");
  }
  const seen = new Set();
  for (const caseId of caseIds) {
    if (!ALWAYS_ON_CASE_IDS.includes(caseId)) {
      throw new Error(`Unknown caseId requested: ${caseId}`);
    }
    if (seen.has(caseId)) {
      throw new Error(`Duplicate case selection: ${caseId}`);
    }
    seen.add(caseId);
  }
  return [...caseIds];
}

async function loadAlwaysOnCorpus({ caseIds, workflowContext }) {
  const selectedCaseIds = normalizeAlwaysOnCaseIds(caseIds);
  const benchmarkInfo = await loadWorkflowBenchmark();
  const captureSet = await loadValidatedCaptureSet({
    workflowContext,
    caseIds: selectedCaseIds,
  });
  const agentCases = {};
  const gradeCases = {};
  const scenarioPlans = {};

  for (const caseId of selectedCaseIds) {
    const sourceCase = benchmarkInfo.caseMap[caseId];
    const scenario = await prepareWorkflowScenario(caseId, "default", {}, workflowContext);
    scenarioPlans[caseId] = {
      caseId,
      sourceCaseName: caseId,
      category: sourceCase.target,
      variantCount: 1,
      variants: [{ id: "default", gateSpec: scenario.gateSpec }],
      suiteId: ALWAYS_ON_SUITE_ID,
    };
    agentCases[caseId] = {
      id: caseId,
      task: sourceCase.request,
      inputFiles: scenario.inputFiles,
    };
    gradeCases[caseId] = {
      id: caseId,
      expected: [...sourceCase.mandatoryChecks, ...benchmarkInfo.benchmark.commonMandatoryChecks],
      expectedCount: sourceCase.mandatoryChecks.length + benchmarkInfo.benchmark.commonMandatoryChecks.length,
      variantGateSpecs: { default: scenario.gateSpec },
      expectedCapabilities: buildExpectedCapabilities(caseId),
    };
  }

  const sourceManifest = {
    suiteId: ALWAYS_ON_SUITE_ID,
    sourcePath: path.relative(REPO_ROOT, BENCHMARK_FIXTURE_PATH),
    sourceSha256: benchmarkInfo.sha256,
    sourceCaseCount: ALWAYS_ON_CASE_IDS.length,
    selectedCaseCount: selectedCaseIds.length,
    selectedCaseIds,
    expectedCount: benchmarkInfo.specificCheckCount,
    commonCheckCount: benchmarkInfo.commonCheckCount,
    approvedContractSha256: APPROVED_CONTRACT_SHA256,
    captureManifestSha256: captureSet.manifestSha256,
    captureSetPath: captureSet.manifestPath,
    workflowContext: {
      validationMode: workflowContext.validationMode,
      liveValidationId: workflowContext.liveValidationId,
      liveReceiptRoot: workflowContext.liveReceiptRoot,
    },
    casesById: Object.fromEntries(
      selectedCaseIds.map((caseId) => {
        const sourceCase = benchmarkInfo.caseMap[caseId];
        return [
          caseId,
          {
            requestSha256: sourceCase.requestSha256,
            mandatoryCheckCount: sourceCase.mandatoryChecks.length,
            commonCheckCount: benchmarkInfo.commonCheckCount,
            expectedCapabilities: buildExpectedCapabilities(caseId),
          },
        ];
      })
    ),
  };

  return { agentCases, gradeCases, scenarioPlans, sourceManifest };
}

export async function loadGraderPrompt() {
  const [prompt, license, transport] = await Promise.all([
    readFile(VENDORED_GRADER_PATH, "utf8"),
    readFile(VENDORED_LICENSE_PATH, "utf8"),
    readFile(GRADER_TRANSPORT_PATH, "utf8"),
  ]);

  const promptSha256 = sha256(prompt);
  const licenseSha256 = sha256(license);
  if (promptSha256 !== EXPECTED_GRADER_SHA256) {
    throw new Error(`Vendored grader hash mismatch. expected=${EXPECTED_GRADER_SHA256} actual=${promptSha256}`);
  }
  if (licenseSha256 !== EXPECTED_LICENSE_SHA256) {
    throw new Error(`Vendored license hash mismatch. expected=${EXPECTED_LICENSE_SHA256} actual=${licenseSha256}`);
  }

  return {
    prompt,
    transport,
    license,
    promptSha256,
    transportSha256: sha256(transport),
    licenseSha256,
  };
}

export async function loadCorpus({ suiteId = "legacy52", caseIds, workflowContext } = {}) {
  if (suiteId === ALWAYS_ON_SUITE_ID) {
    return loadAlwaysOnCorpus({ caseIds, workflowContext });
  }
  if (suiteId !== "legacy52") {
    throw new Error(`Unknown suiteId '${suiteId}'.`);
  }

  assertSelectionSemantics(caseIds);
  assertDependencyOrdering(caseIds);

  const { raw, cases } = await loadSourceCases();
  const required = listRequiredCases();
  if (required.length !== 52) {
    throw new Error("Required case list must contain exactly 52 entries.");
  }

  const sourceCases = [...cases];
  const sourceNames = new Set(sourceCases.map((entry) => entry.name));
  for (const requiredCase of required) {
    if (!sourceNames.has(requiredCase)) {
      throw new Error(`Required case '${requiredCase}' is missing from source corpus.`);
    }
  }

  const requestedCaseIds = Array.isArray(caseIds) ? caseIds : sourceCases.map((entry) => entry.name);
  assertUniqueCaseSelection(requestedCaseIds);
  const selectedCases = requestedCaseIds.map((caseId) => {
    const found = sourceCases.find((entry) => entry.name === caseId);
    if (!found) {
      throw new Error(`Unknown caseId requested: ${caseId}`);
    }
    return found;
  });

  const scenarioPlansAll = await buildScenarioPlans(sourceCases);
  const scenarioPlans = Object.fromEntries(selectedCases.map((entry) => [entry.name, scenarioPlansAll[entry.name]]));

  const agentCases = {};
  const gradeCases = {};
  for (const sourceCase of selectedCases) {
    const plan = scenarioPlans[sourceCase.name];
    const observationMap = Object.fromEntries(
      (plan.variants[0].observationRefs ?? []).map((ref) => [
        ref.name,
        {
          name: ref.name,
          sourcePath: ref.sourcePath,
        },
      ])
    );
    agentCases[sourceCase.name] = buildAgentCase(sourceCase, plan, observationMap);
    gradeCases[sourceCase.name] = buildGradeCase(sourceCase, plan);
  }

  const sourceManifest = createLegacySourceManifest(raw, sourceCases, selectedCases);
  return { agentCases, gradeCases, scenarioPlans, sourceManifest };
}
