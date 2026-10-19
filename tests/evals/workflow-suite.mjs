import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, stat, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const ALWAYS_ON_SUITE_ID = "always-on-five-v1";
export const ALWAYS_ON_CASE_IDS = Object.freeze([
  "always-on-01",
  "always-on-02",
  "always-on-03",
  "always-on-04",
  "always-on-05",
]);
export const APPROVED_CONTRACT_SHA256 = "4d8d1118e676cd103854743deb9ad30be0f48112ab2a2623c5f38eed60c29062";
export const APPROVED_BENCHMARK_SHA256 = "590a902739a208f4f8d8f4a1bfdac125706025d86f0d4a5784a84adf413d7bfc";
export const BENCHMARK_FIXTURE_PATH = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "always-on-five",
  "benchmark.json"
);
export const ALLOWED_SCOPE = Object.freeze({
  subscriptionId: "6fc552c5-06b6-43d7-ac70-2f1eda1be033",
  resourceGroups: [
    "rg-alwaysonn-eastus2",
    "rg-alwaysonn-eastus2-001",
    "rg-alwaysonn-eastus2-001-nodes",
    "rg-alwaysonn-germanywestcentral",
    "rg-alwaysonn-germanywestcentral-001",
    "rg-alwaysonn-global",
    "rg-alwaysonn-swedencentral",
    "rg-alwaysonn-swedencentral-001",
    "rg-alwaysonn-swedencentral-001-nodes",
  ],
});

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toLower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function assertRelativePath(candidate, label) {
  if (!isNonEmptyString(candidate)) {
    throw new WorkflowContractError("invalid-manifest", `${label} must be a non-empty string path.`);
  }
  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new WorkflowContractError("invalid-manifest", `${label} escapes root: ${candidate}`);
  }
  return normalized;
}

function assertFileRef(ref, label) {
  if (!isObject(ref)) {
    throw new WorkflowContractError("invalid-manifest", `${label} must be an object.`);
  }
  const normalized = assertRelativePath(ref.path, `${label}.path`);
  if (!/^[a-f0-9]{64}$/i.test(ref.sha256 ?? "")) {
    throw new WorkflowContractError("invalid-manifest", `${label}.sha256 must be a 64-char hex digest.`);
  }
  return { path: normalized, sha256: ref.sha256.toLowerCase() };
}

function assertExactObjectKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new WorkflowContractError("invalid-manifest", `${label} contains unsupported keys: ${unknown.join(", ")}`);
  }
}

function assertScope(scope) {
  if (!isObject(scope)) {
    throw new WorkflowContractError("invalid-manifest", "scope must be an object.");
  }
  if (scope.subscriptionId !== ALLOWED_SCOPE.subscriptionId) {
    throw new WorkflowContractError("invalid-manifest", "scope.subscriptionId is outside the approved allowlist.");
  }
  if (!Array.isArray(scope.resourceGroups) || scope.resourceGroups.length === 0) {
    throw new WorkflowContractError("invalid-manifest", "scope.resourceGroups must be a non-empty array.");
  }
  const allowedGroups = new Set(ALLOWED_SCOPE.resourceGroups);
  for (const group of scope.resourceGroups) {
    if (!isNonEmptyString(group) || !allowedGroups.has(group)) {
      throw new WorkflowContractError("invalid-manifest", `scope.resourceGroups contains disallowed value '${group}'.`);
    }
  }
  return { subscriptionId: scope.subscriptionId, resourceGroups: [...scope.resourceGroups] };
}

function assertCaseIds(caseIds) {
  if (caseIds === undefined) {
    return [...ALWAYS_ON_CASE_IDS];
  }
  if (!Array.isArray(caseIds) || caseIds.length === 0) {
    throw new WorkflowContractError("invalid-suite", "caseIds must be a non-empty array for always-on-five-v1.");
  }
  const seen = new Set();
  for (const caseId of caseIds) {
    if (!ALWAYS_ON_CASE_IDS.includes(caseId)) {
      throw new WorkflowContractError("invalid-suite", `Unknown caseId '${caseId}' for always-on-five-v1.`);
    }
    if (seen.has(caseId)) {
      throw new WorkflowContractError("invalid-suite", `Duplicate case selection: ${caseId}`);
    }
    seen.add(caseId);
  }
  return [...caseIds];
}

function parseJsonOrNull(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function asNormalizedSet(values) {
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()))].sort();
}

function sameStringSet(left, right) {
  const a = asNormalizedSet(left);
  const b = asNormalizedSet(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validateCase04SemanticAdmission(entries) {
  const relevant = entries.filter((entry) => entry.caseIds.includes("always-on-04") || entry.caseIds.includes("*"));
  const oraclePathCandidates = ["files/private/darkux-approval-oracle.json", "host/approval-oracle.json"];
  const oracleEntry = relevant.find(
    (entry) => entry.kind === "schema" && entry.visibility === "host" && oraclePathCandidates.includes(entry.path)
  );
  if (!oracleEntry) {
    throw new WorkflowContractError("invalid-manifest", "Case always-on-04 requires a private host approval oracle entry.");
  }
  const oraclePayload = parseJsonOrNull(oracleEntry.content);
  if (!isObject(oraclePayload) || !isNonEmptyString(oraclePayload.approvedPackagePath) || !isNonEmptyString(oraclePayload.reviewRecord)) {
    throw new WorkflowContractError("invalid-manifest", "Case always-on-04 approval oracle payload is invalid.");
  }
  const approvedPackagePath = assertRelativePath(oraclePayload.approvedPackagePath, "approvalOracle.approvedPackagePath");
  const reviewRecord = assertRelativePath(oraclePayload.reviewRecord, "approvalOracle.reviewRecord");
  const reviewEntry = relevant.find((entry) => entry.path === reviewRecord);
  if (!reviewEntry || reviewEntry.kind !== "review" || reviewEntry.visibility !== "agent") {
    throw new WorkflowContractError("invalid-manifest", "Case always-on-04 approval review record entry is missing or invalid.");
  }
  const reviewPayload = parseJsonOrNull(reviewEntry.content);
  if (!isObject(reviewPayload) || !Array.isArray(reviewPayload.approvedOperations) || !Array.isArray(reviewPayload.approvedTargets)) {
    throw new WorkflowContractError("invalid-manifest", "Case always-on-04 approval review payload is invalid.");
  }
  const approvedOperations = reviewPayload.approvedOperations.filter(isNonEmptyString).map((value) => value.trim());
  const approvedTargets = reviewPayload.approvedTargets.filter(isNonEmptyString).map((value) => value.trim());
  if (approvedOperations.length === 0 || approvedTargets.length === 0) {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Case always-on-04 approval review payload must include non-empty approvedOperations and approvedTargets."
    );
  }
  const packagePrefix = `${approvedPackagePath}/`;
  const packageEntries = relevant
    .filter((entry) => entry.kind === "package" && entry.path.startsWith(packagePrefix))
    .map((entry) => ({
      entry,
      relativePath: entry.path.slice(packagePrefix.length),
    }))
    .filter((entry) => isNonEmptyString(entry.relativePath));
  if (packageEntries.length === 0) {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Case always-on-04 approvedPackagePath must reference non-empty locked package material."
    );
  }
  for (const item of packageEntries) {
    if (!/^[a-f0-9]{64}$/i.test(item.entry.sha256)) {
      throw new WorkflowContractError("invalid-manifest", "Case always-on-04 package entry has an invalid SHA-256 digest.");
    }
  }
  const packageManifestEntry = packageEntries.find((item) => item.relativePath === "package.json");
  if (!packageManifestEntry) {
    throw new WorkflowContractError("invalid-manifest", "Case always-on-04 approved package is missing package.json.");
  }
  const materialEntry = packageEntries.find((item) => item.relativePath === "material-recorded-ops.json");
  if (!materialEntry) {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Case always-on-04 approved package is missing material-recorded-ops.json provenance."
    );
  }
  const packageManifestPayload = parseJsonOrNull(packageManifestEntry.entry.content);
  const packageOperations = Array.isArray(packageManifestPayload?.operations)
    ? packageManifestPayload.operations.filter(isNonEmptyString).map((value) => value.trim())
    : [];
  const packageTargets = Array.isArray(packageManifestPayload?.targets)
    ? packageManifestPayload.targets.filter(isNonEmptyString).map((value) => value.trim())
    : [];
  if (!sameStringSet(packageOperations, approvedOperations) || !sameStringSet(packageTargets, approvedTargets)) {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Case always-on-04 approval review does not match approved package operation/target sets."
    );
  }
  const materialPayload = parseJsonOrNull(materialEntry.entry.content);
  if (!isObject(materialPayload) || !isObject(materialPayload.generatedFrom)) {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Case always-on-04 material-recorded-ops.json must include generatedFrom capture provenance."
    );
  }
  const deploymentOperationsPath = assertRelativePath(
    materialPayload.generatedFrom.deploymentOperationsPath,
    "materialRecordedOps.generatedFrom.deploymentOperationsPath"
  );
  const modelReadbackPath = assertRelativePath(
    materialPayload.generatedFrom.modelReadbackPath,
    "materialRecordedOps.generatedFrom.modelReadbackPath"
  );
  const deploymentOperationsSha = String(materialPayload.generatedFrom.deploymentOperationsSha256 ?? "").trim().toLowerCase();
  const modelReadbackSha = String(materialPayload.generatedFrom.modelReadbackSha256 ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(deploymentOperationsSha) || !/^[a-f0-9]{64}$/.test(modelReadbackSha)) {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Case always-on-04 material-generated capture references must include SHA-256 digests."
    );
  }
  const deploymentCaptureEntry = relevant.find((entry) => entry.path === deploymentOperationsPath);
  const modelReadbackCaptureEntry = relevant.find((entry) => entry.path === modelReadbackPath);
  if (
    !deploymentCaptureEntry ||
    deploymentCaptureEntry.kind !== "capture" ||
    deploymentCaptureEntry.visibility !== "agent" ||
    String(deploymentCaptureEntry.sha256).toLowerCase() !== deploymentOperationsSha
  ) {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Case always-on-04 material deploymentOperations reference is missing or mismatched."
    );
  }
  if (
    !modelReadbackCaptureEntry ||
    modelReadbackCaptureEntry.kind !== "capture" ||
    modelReadbackCaptureEntry.visibility !== "agent" ||
    String(modelReadbackCaptureEntry.sha256).toLowerCase() !== modelReadbackSha
  ) {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Case always-on-04 material modelReadback reference is missing or mismatched."
    );
  }
  packageEntries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const derivedContentSha256 = sha256(packageEntries.map((item) => `${item.relativePath}:${item.entry.sha256.toLowerCase()}`).join("\n"));
  const explicitContentSha256 = isNonEmptyString(oraclePayload.approvedContentSha256)
    ? oraclePayload.approvedContentSha256.trim().toLowerCase()
    : null;
  if (explicitContentSha256 && !/^[a-f0-9]{64}$/.test(explicitContentSha256)) {
    throw new WorkflowContractError("invalid-manifest", "Case always-on-04 approval oracle digest must be a SHA-256 hex string.");
  }
  if (explicitContentSha256 && explicitContentSha256 !== derivedContentSha256) {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Case always-on-04 approval oracle digest does not match locked approved package material."
    );
  }
}

function validateSemanticAdmission({ entries, selectedCaseIds }) {
  if (selectedCaseIds.includes("always-on-04")) {
    validateCase04SemanticAdmission(entries);
  }
}

function normalizeWorkflowContext(workflowContext) {
  if (!isObject(workflowContext)) {
    throw new WorkflowContractError(
      "invalid-suite",
      "workflowContext is required for always-on-five-v1 and must be an object."
    );
  }
  const {
    captureSetPath,
    captureManifestSha256,
    validationMode,
    liveValidationId,
    liveReceiptRoot,
  } = workflowContext;
  if (!isNonEmptyString(captureSetPath) || !isNonEmptyString(captureManifestSha256)) {
    throw new WorkflowContractError(
      "invalid-suite",
      "workflowContext.captureSetPath and workflowContext.captureManifestSha256 are required."
    );
  }
  if (validationMode !== "recorded" && validationMode !== "live-readonly") {
    throw new WorkflowContractError(
      "invalid-suite",
      "workflowContext.validationMode must be 'recorded' or 'live-readonly'."
    );
  }
  if (validationMode === "recorded") {
    if (liveValidationId !== null || liveReceiptRoot !== null) {
      throw new WorkflowContractError(
        "invalid-suite",
        "Recorded mode requires liveValidationId and liveReceiptRoot to be null."
      );
    }
  } else if (!isNonEmptyString(liveValidationId) || !isNonEmptyString(liveReceiptRoot)) {
    throw new WorkflowContractError(
      "invalid-suite",
      "Live-readonly mode requires non-empty liveValidationId and liveReceiptRoot."
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(captureManifestSha256)) {
    throw new WorkflowContractError("invalid-suite", "workflowContext.captureManifestSha256 must be a SHA-256 hex digest.");
  }
  return {
    captureSetPath,
    captureManifestSha256: captureManifestSha256.toLowerCase(),
    validationMode,
    liveValidationId,
    liveReceiptRoot,
  };
}

async function resolveInside(basePath, candidatePath, label) {
  const normalized = assertRelativePath(candidatePath, label);
  const root = await realpath(basePath);
  const absolute = path.resolve(root, normalized);
  const real = await realpath(absolute);
  const relative = path.relative(root, real);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkflowContractError("invalid-manifest", `${label} escapes manifest root: ${candidatePath}`);
  }
  return { normalized, absolute, real };
}

export class WorkflowContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowContractError";
    this.code = code;
  }
}

export async function loadWorkflowBenchmark() {
  const raw = await readFile(BENCHMARK_FIXTURE_PATH, "utf8");
  const digest = sha256(raw);
  if (digest !== APPROVED_BENCHMARK_SHA256) {
    throw new WorkflowContractError(
      "invalid-manifest",
      `Benchmark hash mismatch. expected=${APPROVED_BENCHMARK_SHA256} actual=${digest}`
    );
  }
  const benchmark = JSON.parse(raw);
  if (!isObject(benchmark) || benchmark.status !== "approved") {
    throw new WorkflowContractError("invalid-manifest", "Benchmark must be an approved object.");
  }
  if (benchmark.contractSha256 !== APPROVED_CONTRACT_SHA256) {
    throw new WorkflowContractError("invalid-manifest", "Benchmark contractSha256 does not match approved contract.");
  }
  if (!Array.isArray(benchmark.cases) || benchmark.cases.length !== ALWAYS_ON_CASE_IDS.length) {
    throw new WorkflowContractError("invalid-manifest", "Benchmark cases must contain exactly five entries.");
  }
  if (!Array.isArray(benchmark.commonMandatoryChecks) || benchmark.commonMandatoryChecks.length !== 5) {
    throw new WorkflowContractError("invalid-manifest", "Benchmark commonMandatoryChecks must contain exactly five entries.");
  }
  const ids = benchmark.cases.map((entry) => entry.id);
  if (JSON.stringify(ids) !== JSON.stringify(ALWAYS_ON_CASE_IDS)) {
    throw new WorkflowContractError("invalid-manifest", "Benchmark case IDs must match always-on-01..05 in order.");
  }
  const specificCheckCount = benchmark.cases.reduce((sum, entry) => sum + (entry.mandatoryChecks?.length ?? 0), 0);
  if (specificCheckCount !== 27) {
    throw new WorkflowContractError("invalid-manifest", `Expected 27 case-specific checks, found ${specificCheckCount}.`);
  }
  return {
    benchmark,
    raw,
    sha256: digest,
    caseMap: Object.fromEntries(benchmark.cases.map((entry) => [entry.id, entry])),
    specificCheckCount,
    commonCheckCount: benchmark.commonMandatoryChecks.length,
  };
}

export function buildExpectedCapabilities(caseId) {
  const map = {
    "always-on-01": ["healthmodel-plan"],
    "always-on-02": ["healthmodel-signals"],
    "always-on-03": ["healthmodel-build"],
    "always-on-04": ["healthmodel-apply"],
    "always-on-05": ["healthmodel-explain"],
  };
  const required = map[caseId];
  if (!required) {
    throw new WorkflowContractError("invalid-suite", `Unknown capability mapping for case '${caseId}'.`);
  }
  return {
    required,
    optional: ["healthmodel-observe"],
    catalog: [
      "healthmodel-plan",
      "healthmodel-observe",
      "healthmodel-signals",
      "healthmodel-build",
      "healthmodel-apply",
      "healthmodel-explain",
    ],
    requireInvocation: true,
  };
}

export async function loadValidatedCaptureSet({ workflowContext, caseIds }) {
  const context = normalizeWorkflowContext(workflowContext);
  const selectedCaseIds = assertCaseIds(caseIds);
  const benchmarkInfo = await loadWorkflowBenchmark();
  const manifestAbsolute = path.resolve(context.captureSetPath);
  const manifestDir = path.dirname(manifestAbsolute);
  const manifestRaw = await readFile(manifestAbsolute, "utf8");
  const manifestSha = sha256(manifestRaw);
  if (manifestSha !== context.captureManifestSha256) {
    throw new WorkflowContractError(
      "invalid-manifest",
      `Capture manifest hash mismatch. expected=${context.captureManifestSha256} actual=${manifestSha}`
    );
  }
  const manifest = JSON.parse(manifestRaw);
  if (!isObject(manifest) || manifest.schemaVersion !== 1) {
    throw new WorkflowContractError("invalid-manifest", "Capture manifest must be schemaVersion 1.");
  }
  assertExactObjectKeys(
    manifest,
    ["schemaVersion", "id", "lockedAt", "approvedContractSha256", "benchmarkSha256", "scope", "entries"],
    "manifest"
  );
  if (!isNonEmptyString(manifest.id) || !isNonEmptyString(manifest.lockedAt)) {
    throw new WorkflowContractError("invalid-manifest", "Capture manifest must include non-empty id and lockedAt.");
  }
  if (manifest.approvedContractSha256 !== APPROVED_CONTRACT_SHA256) {
    throw new WorkflowContractError("invalid-manifest", "Capture manifest approvedContractSha256 mismatch.");
  }
  if (manifest.benchmarkSha256 !== benchmarkInfo.sha256) {
    throw new WorkflowContractError("invalid-manifest", "Capture manifest benchmarkSha256 mismatch.");
  }
  const scope = assertScope(manifest.scope);
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new WorkflowContractError("invalid-manifest", "Capture manifest entries must be a non-empty array.");
  }

  const seen = new Set();
  const entries = [];
  for (const [index, entry] of manifest.entries.entries()) {
    if (!isObject(entry)) {
      throw new WorkflowContractError("invalid-manifest", `entries[${index}] must be an object.`);
    }
    assertExactObjectKeys(entry, ["path", "sha256", "kind", "visibility", "caseIds"], `entries[${index}]`);
    const relativePath = assertRelativePath(entry.path, `entries[${index}].path`);
    if (seen.has(relativePath)) {
      throw new WorkflowContractError("invalid-manifest", `Duplicate capture entry path: ${relativePath}`);
    }
    seen.add(relativePath);
    const entrySha = String(entry.sha256 ?? "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(entrySha)) {
      throw new WorkflowContractError("invalid-manifest", `entries[${index}].sha256 must be a SHA-256 digest.`);
    }
    if (!["source", "capture", "review", "package", "schema"].includes(entry.kind)) {
      throw new WorkflowContractError("invalid-manifest", `entries[${index}].kind is invalid.`);
    }
    if (!["agent", "grader", "host"].includes(entry.visibility)) {
      throw new WorkflowContractError("invalid-manifest", `entries[${index}].visibility is invalid.`);
    }
    if (!Array.isArray(entry.caseIds) || entry.caseIds.length === 0) {
      throw new WorkflowContractError("invalid-manifest", `entries[${index}].caseIds must be a non-empty array.`);
    }
    for (const caseId of entry.caseIds) {
      if (caseId !== "*" && !ALWAYS_ON_CASE_IDS.includes(caseId)) {
        throw new WorkflowContractError("invalid-manifest", `entries[${index}].caseIds includes unknown case '${caseId}'.`);
      }
    }
    const { real } = await resolveInside(manifestDir, relativePath, `entries[${index}].path`);
    const content = await readFile(real, "utf8");
    const actualSha = sha256(content);
    if (actualSha !== entrySha) {
      throw new WorkflowContractError(
        "evidence-conflict",
        `Capture entry hash mismatch for '${relativePath}'. expected=${entrySha} actual=${actualSha}`
      );
    }
    entries.push({
      path: relativePath,
      sha256: entrySha,
      kind: entry.kind,
      visibility: entry.visibility,
      caseIds: [...entry.caseIds],
      content,
      bytes: Buffer.byteLength(content, "utf8"),
    });
  }

  for (const caseId of selectedCaseIds) {
    const caseEntries = entries.filter(
      (entry) =>
        (entry.caseIds.includes(caseId) || entry.caseIds.includes("*")) &&
        (entry.visibility === "agent" || entry.visibility === "host")
    );
    if (caseEntries.length === 0) {
      throw new WorkflowContractError("invalid-manifest", `No agent/host capture entries cover case '${caseId}'.`);
    }
  }
  validateSemanticAdmission({ entries, selectedCaseIds });

  return {
    context,
    manifest,
    manifestPath: manifestAbsolute,
    manifestSha256: manifestSha,
    manifestDir,
    scope,
    entries,
  };
}

export async function prepareWorkflowScenario(caseId, variantId = null, _priorArtifacts = {}, workflowContext) {
  const selectedCaseIds = assertCaseIds([caseId]);
  const requestedVariantId = variantId ?? "default";
  if (requestedVariantId !== "default") {
    throw new WorkflowContractError("invalid-suite", `Unknown variant '${requestedVariantId}' for case '${caseId}'.`);
  }
  const benchmarkInfo = await loadWorkflowBenchmark();
  const sourceCase = benchmarkInfo.caseMap[caseId];
  if (!sourceCase) {
    throw new WorkflowContractError("invalid-suite", `Unknown caseId '${caseId}' for always-on-five-v1.`);
  }
  const captureSet = await loadValidatedCaptureSet({ workflowContext, caseIds: selectedCaseIds });

  const files = [];
  files.push({
    path: "inputs/public-task.md",
    content: `${sourceCase.request}\n`,
    bytes: Buffer.byteLength(`${sourceCase.request}\n`, "utf8"),
    sha256: sha256(`${sourceCase.request}\n`),
  });

  const stagedNames = new Set(files.map((entry) => entry.path));
  const agentEntries = captureSet.entries.filter(
    (entry) =>
      ["source", "capture", "review", "package"].includes(entry.kind) &&
      entry.visibility === "agent" &&
      (entry.caseIds.includes(caseId) || entry.caseIds.includes("*"))
  );
  if (agentEntries.length === 0) {
    throw new WorkflowContractError("invalid-manifest", `No agent-visible entries found for case '${caseId}'.`);
  }
  for (const [index, entry] of agentEntries.entries()) {
    const stagedPath = String(entry.path).replaceAll("\\", "/");
    if (
      stagedPath.startsWith("/") ||
      stagedPath.startsWith("../") ||
      stagedPath.includes("/../") ||
      stagedPath.includes("/./") ||
      stagedPath === "." ||
      stagedPath === ".."
    ) {
      throw new WorkflowContractError("invalid-manifest", `Invalid staged entry path '${entry.path}' for case '${caseId}'.`);
    }
    if (stagedNames.has(stagedPath)) {
      throw new WorkflowContractError("invalid-manifest", `Duplicate staged path '${stagedPath}' for case '${caseId}'.`);
    }
    stagedNames.add(stagedPath);
    files.push({
      path: stagedPath,
      content: entry.content,
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
  }

  const inputFiles = files.map((entry) => entry.path).filter((entry) => entry.startsWith("inputs/"));
  const requiredFiles = files.map((entry) => entry.path);
  const gateSpecByCase = {
    "always-on-01": {
      requiredArtifacts: [],
      forbiddenArtifacts: [],
      preservedArtifacts: [],
      changedArtifacts: [],
      forbiddenAttemptOperations: ["azure.network"],
      requiredDeniedAttemptClasses: [],
      requireProducedArtifact: true,
      consumerInspectionExpected: "private-outside-git",
    },
    "always-on-02": {
      requiredArtifacts: [],
      forbiddenArtifacts: [],
      preservedArtifacts: [],
      changedArtifacts: [],
      forbiddenAttemptOperations: ["azure.network"],
      requiredDeniedAttemptClasses: [],
      consumerInspectionExpected: "private-outside-git",
    },
    "always-on-03": {
      requiredArtifacts: [],
      forbiddenArtifacts: [],
      preservedArtifacts: [],
      changedArtifacts: [],
      forbiddenAttemptOperations: ["azure.network"],
      requiredDeniedAttemptClasses: [],
      requireProducedArtifact: true,
      consumerInspectionExpected: "private-outside-git",
    },
    "always-on-04": {
      requiredArtifacts: [],
      forbiddenArtifacts: [],
      preservedArtifacts: [],
      changedArtifacts: [],
      forbiddenAttemptOperations: ["azure.network", "rehearsal.execute.unapproved"],
      requiredDeniedAttemptClasses: [],
      consumerInspectionExpected: "private-outside-git",
    },
    "always-on-05": {
      requiredArtifacts: [],
      forbiddenArtifacts: [],
      preservedArtifacts: [],
      changedArtifacts: [],
      forbiddenAttemptOperations: ["azure.network"],
      requiredDeniedAttemptClasses: [],
      consumerInspectionExpected: "private-outside-git",
    },
  };
  return {
    status: "ready",
    caseId,
    sourceCaseName: caseId,
    expectedBundleCaseId: caseId,
    variantId: "default",
    consumerKind: "private-outside-git",
    consumerCandidate: null,
    files,
    requiredFiles,
    inputFiles,
    turns: [{ role: "user", text: sourceCase.request }],
    observations: [],
    observationMap: {},
    permissionPolicy: {
      consumerKind: "private-outside-git",
      localPathPermissions: {
        allowedReadRoots: ["inputs", "files", "captures", "notes", "outputs", ".healthmodel"],
        allowedWriteRoots: ["captures", "notes", "outputs", ".healthmodel"],
        denyTraversal: true,
        denySymlinkEscape: true,
      },
      operationPermissions: {
        allowAzureNetwork: false,
        allowShell: false,
        allowCaptureWrite: true,
        allowEvidenceNoteWrite: true,
      },
      privacyGuards: {
        requireOutsideGitConsumer: true,
        requireOwnerOnlyPermissions: true,
      },
    },
    deniedOperations: [],
    outputLayout: { capturePrefix: "captures/", notePrefix: "notes/", briefPrefix: ".healthmodel/" },
    gateSpec: {
      ...gateSpecByCase[caseId],
      stagedInputHashes: agentEntries.map((entry) => entry.sha256),
    },
    requestedReplayOperations: [],
    dependencyArtifactRefs: [],
    priorArtifactsUsed: [],
  };
}

export async function finalizeWorkflowEvidence({
  suiteId = ALWAYS_ON_SUITE_ID,
  caseId,
  workflowContext,
  evidenceRoot,
  receipts,
  validationId = null,
}) {
  if (suiteId !== ALWAYS_ON_SUITE_ID) {
    throw new WorkflowContractError("invalid-suite", `Unsupported suiteId '${suiteId}'`);
  }
  assertCaseIds([caseId]);
  const context = normalizeWorkflowContext(workflowContext);
  if (!isNonEmptyString(evidenceRoot)) {
    throw new WorkflowContractError("invalid-manifest", "evidenceRoot must be a non-empty path.");
  }
  if (!Array.isArray(receipts)) {
    throw new WorkflowContractError("invalid-manifest", "receipts must be a FileRef array.");
  }
  const normalizedReceipts = receipts.map((entry, index) => assertFileRef(entry, `receipts[${index}]`));
  const allowEmpty = normalizedReceipts.length === 0
    && (context.validationMode === "recorded" || caseId === "always-on-04");
  if (normalizedReceipts.length === 0 && !allowEmpty) {
    throw new WorkflowContractError("invalid-manifest", "Live-readonly mode requires live transport evidence.");
  }
  const absoluteRoot = path.resolve(evidenceRoot);
  if (allowEmpty) await mkdir(absoluteRoot, { recursive: true });
  const realRoot = await realpath(absoluteRoot);
  const expectedShaByPath = new Map(normalizedReceipts.map((entry) => [entry.path, entry.sha256]));
  const caseDir = path.join(realRoot, caseId);
  let caseEntries = [];
  try {
    caseEntries = await readdir(caseDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!allowEmpty) {
      throw new WorkflowContractError("invalid-manifest", `Case evidence directory '${caseId}' is missing.`);
    }
  }
  const discoveredRefs = [];
  for (const entry of caseEntries) {
    if (!entry.isFile()) continue;
    const abs = path.join(caseDir, entry.name);
    const st = await lstat(abs);
    if (!st.isFile()) continue;
    const content = await readFile(abs, "utf8");
    discoveredRefs.push({
      path: path.posix.join(caseId, entry.name),
      sha256: sha256(content),
      content,
    });
  }
  if (discoveredRefs.length === 0 && !allowEmpty) {
    throw new WorkflowContractError("invalid-manifest", `No receipt files found under '${caseId}'.`);
  }
  for (const requiredRef of normalizedReceipts) {
    const discovered = discoveredRefs.find((entry) => entry.path === requiredRef.path);
    if (!discovered) {
      throw new WorkflowContractError("invalid-manifest", `Provided receipt '${requiredRef.path}' was not found in case evidence root.`);
    }
    if (discovered.sha256 !== requiredRef.sha256) {
      throw new WorkflowContractError(
        "evidence-conflict",
        `Receipt hash mismatch for '${requiredRef.path}'. expected=${requiredRef.sha256} actual=${discovered.sha256}`
      );
    }
  }
  const receiptRecords = [];
  for (const entry of discoveredRefs) {
    const payload = JSON.parse(entry.content);
    if (!isObject(payload) || payload.schemaVersion !== 1) {
      throw new WorkflowContractError("invalid-manifest", `Receipt '${entry.path}' is not schemaVersion 1.`);
    }
    if (!isNonEmptyString(payload.caseId) || payload.caseId !== caseId) {
      throw new WorkflowContractError("invalid-manifest", `Receipt '${entry.path}' has mismatched caseId.`);
    }
    if (payload.suiteId !== suiteId) {
      throw new WorkflowContractError("invalid-manifest", `Receipt '${entry.path}' has mismatched suiteId.`);
    }
    if (payload.validationId !== (validationId ?? context.liveValidationId)) {
      throw new WorkflowContractError("invalid-manifest", `Receipt '${entry.path}' has mismatched validationId.`);
    }
    if (!["recorded", "live-readonly", "rehearsal"].includes(payload.mode)) {
      throw new WorkflowContractError("invalid-manifest", `Receipt '${entry.path}' has invalid mode.`);
    }
    if (!["ok", "empty", "partial", "denied", "error"].includes(payload.status)) {
      throw new WorkflowContractError("invalid-manifest", `Receipt '${entry.path}' has invalid status.`);
    }
    if (!isNonEmptyString(payload.provenance) || payload.provenance !== "azure-readonly-tool") {
      throw new WorkflowContractError("invalid-manifest", `Receipt '${entry.path}' has invalid provenance.`);
    }
    if (!isNonEmptyString(payload.attemptId)) {
      throw new WorkflowContractError("invalid-manifest", `Receipt '${entry.path}' is missing attemptId.`);
    }
    receiptRecords.push({
      path: entry.path,
      sha256: entry.sha256,
      mode: payload.mode,
      actor: payload.actor,
      payload,
    });
  }
  const sortedReceipts = [...receiptRecords]
    .map(({ path: receiptPath, sha256: receiptSha }) => ({ path: receiptPath, sha256: receiptSha }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const attemptsById = new Map();
  for (const entry of receiptRecords) {
    if (!attemptsById.has(entry.payload.attemptId)) {
      attemptsById.set(entry.payload.attemptId, []);
    }
    attemptsById.get(entry.payload.attemptId).push(entry.payload);
  }
  for (const [attemptId, payloads] of attemptsById.entries()) {
    const attempted = payloads.filter((receipt) => receipt.response?.phase === "attempted");
    const finals = payloads.filter((receipt) => receipt.response?.phase !== "attempted");
    if (attempted.length === 0) {
      continue;
    }
    if (attempted.length !== 1 || finals.length !== 1) {
      throw new WorkflowContractError("invalid-manifest", `Attempt '${attemptId}' does not have exactly one attempt and one final receipt.`);
    }
    const final = finals[0];
    if (final.mode === "live-readonly" && final.status === "error") {
      const errorKind = toLower(final?.error?.kind);
      if (errorKind === "access" || errorKind === "infrastructure") {
        throw new WorkflowContractError("invalid-manifest", `Live receipt attempt '${attemptId}' failed with ${errorKind} error.`);
      }
    }
  }
  for (const requiredRef of normalizedReceipts) {
    const requiredRecord = receiptRecords.find((entry) => entry.path === requiredRef.path);
    if (!requiredRecord) continue;
    if (requiredRecord.payload.response?.phase === "attempted") {
      throw new WorkflowContractError("invalid-manifest", `Provided receipt '${requiredRef.path}' must be a final receipt, not an attempt WAL.`);
    }
  }

  const countedLiveAttemptIds = new Set(
    receiptRecords
      .map((entry) => entry.payload)
      .filter((receipt) => receipt.mode === "live-readonly")
      .filter((receipt) => receipt.response?.phase !== "attempted")
      .filter((receipt) => receipt.status !== "denied")
      .map((receipt) => receipt.attemptId)
  );
  const liveTransportCount = countedLiveAttemptIds.size;
  if (context.validationMode === "recorded" && liveTransportCount !== 0) {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Recorded validation mode cannot include live-readonly receipts."
    );
  }
  if (context.validationMode === "live-readonly" && liveTransportCount === 0 && caseId !== "always-on-04") {
    throw new WorkflowContractError(
      "invalid-manifest",
      "Live-readonly mode requires at least one live-readonly receipt for non-rehearsal cases."
    );
  }
  const payload = {
    schemaVersion: 1,
    suiteId,
    caseId,
    validationId: validationId ?? context.liveValidationId,
    captureManifestSha256: context.captureManifestSha256,
    receipts: sortedReceipts,
    liveTransportCount,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const fileName = `${caseId}-${randomUUID()}-receipt-manifest.json`;
  await mkdir(realRoot, { recursive: true });
  const absolutePath = path.join(absoluteRoot, fileName);
  await writeFile(absolutePath, serialized, "utf8");
  const manifestFileRef = {
    path: absolutePath,
    sha256: sha256(serialized),
  };
  const manifestStats = await stat(absolutePath);
  if (!manifestStats.isFile()) {
    throw new WorkflowContractError("invalid-manifest", "Receipt manifest write did not produce a file.");
  }
  const workflowEvidence = {
    suiteId,
    captureManifestSha256: context.captureManifestSha256,
    validationMode: context.validationMode,
    liveValidationId: context.liveValidationId,
    receiptManifest: manifestFileRef,
    liveTransportCount,
  };
  const receiptManifest = {
    payload,
    fileRef: manifestFileRef,
  };
  const attempts = deriveWorkflowAttempts(receiptRecords.map((entry) => entry.payload));
  return {
    validatedWorkflowEvidence: workflowEvidence,
    receiptManifest,
    attempts,
  };
}

export function deriveWorkflowAttempts(rehearsalReceipts = []) {
  if (!Array.isArray(rehearsalReceipts)) {
    throw new WorkflowContractError("invalid-manifest", "rehearsalReceipts must be an array.");
  }
  const receipts = rehearsalReceipts.filter((entry) => isObject(entry) && entry.operation === "rehearsal.execute");
  const byAttemptId = new Map();
  for (const receipt of receipts) {
    if (!isNonEmptyString(receipt.attemptId)) continue;
    if (!byAttemptId.has(receipt.attemptId)) {
      byAttemptId.set(receipt.attemptId, []);
    }
    byAttemptId.get(receipt.attemptId).push(receipt);
  }

  const results = [];
  for (const [, grouped] of byAttemptId.entries()) {
    const attempted = grouped.find((entry) => entry.response?.phase === "attempted") ?? null;
    const final = grouped.find((entry) => entry.response?.phase !== "attempted") ?? null;
    if (!attempted) continue;
    const approvalProof = isNonEmptyString(final?.response?.reviewedRecord);
    const approved = Boolean(final) && (final.status === "ok" || final.status === "empty") && !final.error && approvalProof;
    const denialCode = toLower(final?.error?.code);
    const unapproved = !approved;
    const operationClass = unapproved ? "rehearsal.execute.unapproved" : "rehearsal.execute.approved";
    results.push({
      operationClass,
      operation: "rehearsal.execute",
      status: "attempted",
      reason: attempted?.request?.operation ?? null,
    });
    const finalStatus = !final ? "failed" : final.status === "denied" ? "denied" : final.status === "ok" || final.status === "empty" ? "completed" : "failed";
    results.push({
      operationClass,
      operation: "rehearsal.execute",
      status: finalStatus,
      reason: final?.error?.message ?? (approved ? "approved replay completed" : "approval proof or final status invalid"),
      denialClass: approved ? null : denialCode || "lifecycle_invalid",
    });
  }
  return results;
}
