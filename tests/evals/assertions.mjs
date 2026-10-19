function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function result(pass, reason) {
  return { pass, score: pass ? 1 : 0, reason };
}

function readCreatorGrade(resultLike) {
  return resultLike?.metadata?.creatorGrade ?? resultLike?.creatorGrade ?? null;
}

function validateOptionalClaims(claims, errors) {
  if (claims === undefined) return;
  if (!Array.isArray(claims)) {
    errors.push("claims must be an array when present.");
    return;
  }
  const allowedTypes = new Set(["factual", "process", "quality"]);
  claims.forEach((claim, index) => {
    if (!isObject(claim)) {
      errors.push(`claims[${index}] must be an object.`);
      return;
    }
    if (!isNonEmptyString(claim.claim)) errors.push(`claims[${index}].claim must be a non-empty string.`);
    if (!allowedTypes.has(claim.type)) errors.push(`claims[${index}].type must be factual|process|quality.`);
    if (typeof claim.verified !== "boolean") errors.push(`claims[${index}].verified must be boolean.`);
    if (!isNonEmptyString(claim.evidence)) errors.push(`claims[${index}].evidence must be a non-empty string.`);
  });
}

function validateOptionalUserNotesSummary(summary, errors) {
  if (summary === undefined) return;
  if (!isObject(summary)) {
    errors.push("user_notes_summary must be an object when present.");
    return;
  }
  for (const key of ["uncertainties", "needs_review", "workarounds"]) {
    if (!Array.isArray(summary[key])) {
      errors.push(`user_notes_summary.${key} must be an array.`);
      continue;
    }
    summary[key].forEach((entry, index) => {
      if (!isNonEmptyString(entry)) {
        errors.push(`user_notes_summary.${key}[${index}] must be a non-empty string.`);
      }
    });
  }
}

function validateOptionalEvalFeedback(evalFeedback, errors) {
  if (evalFeedback === undefined) return;
  if (!isObject(evalFeedback)) {
    errors.push("eval_feedback must be an object when present.");
    return;
  }
  if (!Array.isArray(evalFeedback.suggestions)) {
    errors.push("eval_feedback.suggestions must be an array.");
  } else {
    evalFeedback.suggestions.forEach((entry, index) => {
      if (!isObject(entry)) {
        errors.push(`eval_feedback.suggestions[${index}] must be an object.`);
        return;
      }
      if (!isNonEmptyString(entry.reason)) {
        errors.push(`eval_feedback.suggestions[${index}].reason must be a non-empty string.`);
      }
      if (entry.assertion !== undefined && !isNonEmptyString(entry.assertion)) {
        errors.push(`eval_feedback.suggestions[${index}].assertion must be a non-empty string when present.`);
      }
    });
  }
  if (evalFeedback.overall !== undefined && !isNonEmptyString(evalFeedback.overall)) {
    errors.push("eval_feedback.overall must be a non-empty string when present.");
  }
}

export function validateCreatorGrade(grade, expected) {
  const errors = [];
  if (!isObject(grade)) {
    throw new Error("creator grade must be an object.");
  }
  if (grade.error !== undefined) {
    throw new Error("creator grade payload contains an error key and is not gradable.");
  }
  if (!Array.isArray(expected) || expected.some((entry) => !isNonEmptyString(entry))) {
    throw new Error("expected must be a non-empty string array.");
  }

  if (!Array.isArray(grade.expectations)) {
    errors.push("expectations must be an array.");
  }
  const normalizedExpectations = [];
  if (Array.isArray(grade.expectations)) {
    if (grade.expectations.length !== expected.length) {
      errors.push(`expectations length mismatch. expected=${expected.length} actual=${grade.expectations.length}`);
    }
    grade.expectations.forEach((entry, index) => {
      if (!isObject(entry)) {
        errors.push(`expectations[${index}] must be an object.`);
        return;
      }
      if (!isNonEmptyString(entry.text)) {
        errors.push(`expectations[${index}].text must be a non-empty string.`);
      } else if (entry.text !== expected[index]) {
        errors.push(`expectations[${index}].text mismatch. expected='${expected[index]}' actual='${entry.text}'`);
      }
      if (typeof entry.passed !== "boolean") {
        errors.push(`expectations[${index}].passed must be boolean.`);
      }
      if (!isNonEmptyString(entry.evidence)) {
        errors.push(`expectations[${index}].evidence must be a non-empty string.`);
      }
      normalizedExpectations.push({ text: entry.text, passed: entry.passed, evidence: entry.evidence });
    });
  }

  const passed = normalizedExpectations.filter((entry) => entry.passed).length;
  const failed = normalizedExpectations.length - passed;
  const total = normalizedExpectations.length;
  const passRate = total === 0 ? 0 : passed / total;

  if (!isObject(grade.summary)) {
    errors.push("summary must be an object.");
  } else {
    if (grade.summary.passed !== passed) errors.push(`summary.passed mismatch. expected=${passed} actual=${grade.summary.passed}`);
    if (grade.summary.failed !== failed) errors.push(`summary.failed mismatch. expected=${failed} actual=${grade.summary.failed}`);
    if (grade.summary.total !== total) errors.push(`summary.total mismatch. expected=${total} actual=${grade.summary.total}`);
    if (typeof grade.summary.pass_rate !== "number") {
      errors.push("summary.pass_rate must be a number.");
    } else if (Math.abs(grade.summary.pass_rate - passRate) > 1e-9) {
      errors.push(`summary.pass_rate mismatch. expected=${passRate} actual=${grade.summary.pass_rate}`);
    }
  }

  validateOptionalClaims(grade.claims, errors);
  validateOptionalUserNotesSummary(grade.user_notes_summary, errors);
  validateOptionalEvalFeedback(grade.eval_feedback, errors);

  if (errors.length > 0) {
    throw new Error(`Invalid creator grade: ${errors.join(" | ")}`);
  }

  return {
    expectations: normalizedExpectations,
    summary: { passed, failed, total, pass_rate: passRate },
    claims: grade.claims,
    user_notes_summary: grade.user_notes_summary,
    eval_feedback: grade.eval_feedback,
    execution_metrics: grade.execution_metrics,
    timing: grade.timing,
  };
}

function assertCaptureComplete(resultLike) {
  return result(resultLike?.metadata?.captureComplete === true, "captureComplete must be true.");
}

export const PLUGIN_NAMESPACE = "azure-healthmodel-skills";
const SKILL_CALL_SOURCES = new Set([
  "project",
  "inherited",
  "personal-copilot",
  "personal-agents",
  "custom",
  "plugin",
  "builtin",
  "remote",
  "sdk",
]);

function isExpectedSkillName(name, expectedSkill) {
  return name === expectedSkill || name === `${PLUGIN_NAMESPACE}:${expectedSkill}`;
}

function assertSkillUsed(resultLike, expectedSkill, expectedSkillHash = null) {
  const skillCalls = resultLike?.metadata?.skillCalls;
  if (!Array.isArray(skillCalls)) {
    return result(false, "skillCalls missing.");
  }
  const matching = skillCalls.filter((entry) => typeof entry?.name === "string" && isExpectedSkillName(entry.name, expectedSkill));
  if (matching.length === 0) {
    return result(false, `Expected skill '${expectedSkill}' not found.`);
  }
  if (expectedSkillHash && !matching.some((entry) => entry.contentSha256 === expectedSkillHash)) {
    return result(false, "Skill content hash mismatch.");
  }
  return result(true, `Observed expected skill '${expectedSkill}'.`);
}

function normalizeActivationName(value) {
  if (!isNonEmptyString(value)) return null;
  const text = value.trim();
  if (text.startsWith(`${PLUGIN_NAMESPACE}:`)) {
    return text.slice(PLUGIN_NAMESPACE.length + 1);
  }
  return text;
}

function assertCapabilitiesUsed(resultLike, expectedCapabilities) {
  if (!isObject(expectedCapabilities) || !Array.isArray(expectedCapabilities.required) || expectedCapabilities.required.length === 0) {
    return result(false, "expectedCapabilities.required missing.");
  }
  const skillCalls = resultLike?.metadata?.skillCalls;
  if (!Array.isArray(skillCalls) || skillCalls.length === 0) {
    return result(false, "skillCalls missing.");
  }
  const snapshotRoot = resultLike?.metadata?.runtime?.skillSnapshotRoot;
  if (!isNonEmptyString(snapshotRoot)) {
    return result(false, "runtime.skillSnapshotRoot missing.");
  }
  const normalizedRoot = String(snapshotRoot).replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalizedRoot.startsWith("/")) {
    return result(false, "runtime.skillSnapshotRoot must be an absolute snapshot path.");
  }
  const relevant = skillCalls.filter((entry) => {
    const name = normalizeActivationName(entry?.name);
    if (!name) return false;
    const hasPath = isNonEmptyString(entry?.path);
    const hasHash = typeof entry?.contentSha256 === "string" && /^[a-f0-9]{64}$/i.test(entry.contentSha256);
    const hasAllowedSource = SKILL_CALL_SOURCES.has(String(entry?.source ?? ""));
    const hasEventAnchor =
      isNonEmptyString(entry?.id) &&
      isNonEmptyString(entry?.timestamp) &&
      isNonEmptyString(entry?.sessionId) &&
      isNonEmptyString(entry?.candidateSnapshotId);
    if (!hasPath || !hasHash || !hasAllowedSource || !hasEventAnchor) return false;
    const normalizedPath = String(entry.path).replaceAll("\\", "/");
    const inRoot = normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
    if (!inRoot) return false;
    return true;
  });
  const names = new Set(relevant.map((entry) => normalizeActivationName(entry?.name)));
  const sessionIds = new Set(relevant.map((entry) => String(entry.sessionId).trim()));
  const candidateIds = new Set(relevant.map((entry) => String(entry.candidateSnapshotId).trim()));
  if (sessionIds.size !== 1) {
    return result(false, "skillCalls must have one trusted sessionId.");
  }
  if (candidateIds.size !== 1) {
    return result(false, "skillCalls must have one trusted candidateSnapshotId.");
  }
  const runtimeSessionId = resultLike?.metadata?.runtime?.sessionId ?? null;
  if (isNonEmptyString(runtimeSessionId) && !sessionIds.has(String(runtimeSessionId).trim())) {
    return result(false, "skillCalls sessionId does not match runtime.sessionId.");
  }
  const runtimeCandidateSnapshotId = resultLike?.metadata?.runtime?.candidateSnapshotId ?? null;
  if (isNonEmptyString(runtimeCandidateSnapshotId) && !candidateIds.has(String(runtimeCandidateSnapshotId).trim())) {
    return result(false, "skillCalls candidateSnapshotId does not match runtime.candidateSnapshotId.");
  }
  for (const required of expectedCapabilities.required) {
    const pathMatch = relevant.some((entry) => {
      const normalizedPath = String(entry.path).replaceAll("\\", "/");
      return normalizedPath.includes(`/${required}/`) || normalizedPath.endsWith(`/${required}/SKILL.md`);
    });
    if (!names.has(required) || !pathMatch) {
      return result(false, `Missing required invoked capability '${required}'.`);
    }
  }
  return result(true, `Observed required native capabilities: ${expectedCapabilities.required.join(", ")}`);
}

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

const matchesPattern = (pattern, candidate) => typeof candidate === "string" && globToRegExp(pattern).test(candidate);

function checkConsumerInspection(expected, observed) {
  if (!expected) return null;
  if (!isObject(observed)) return "consumerInspection missing.";
  if (observed.kind !== expected) return `consumerInspection kind '${observed.kind}' != expected '${expected}'.`;
  if (expected === "private-outside-git" && !(observed.verified === true && observed.insideGit === false)) {
    return "consumer was not verified private outside Git.";
  }
  if (expected === "inside-git-candidate" && observed.insideGit !== true) return "inside-Git candidate was not observed inside Git.";
  if (expected === "unverified-consumer" && observed.verified !== false) return "unverified consumer was reported verified.";
  return null;
}

// Single pure gate calculation: one {pass, reason} record per declared gate, in evaluation order.
export function computeVariantGateResults(spec, { attempts = [], artifacts = [], consumerInspection, dependencyProvenance = [] } = {}) {
  const gates = {};
  const gate = (id, failure, okReason) => {
    gates[id] = { pass: failure === null, reason: failure ?? okReason };
  };
  const preserved = spec.preservedArtifacts ?? [];
  const changed = spec.changedArtifacts ?? [];
  const settled = new Set([...preserved.map((e) => e.path), ...changed.map((e) => e.path)]);
  const byPath = new Map(artifacts.map((entry) => [entry.path, entry]));

  for (const want of preserved) {
    const found = byPath.get(want.path);
    let failure = null;
    if (!found) failure = `Missing preserved artifact: ${want.path}`;
    else if (found.sha256 !== want.sha256) failure = `Preserved artifact hash mismatch: ${want.path}`;
    else if (typeof want.bytes === "number" && found.bytes !== want.bytes) failure = `Preserved artifact byte-length mismatch: ${want.path}`;
    gate(`preservedArtifact:${want.path}`, failure, `Preserved artifact '${want.path}' matched expected hash/bytes.`);
  }
  for (const want of changed) {
    const found = byPath.get(want.path);
    let failure = null;
    if (!found) failure = `Missing changed artifact: ${want.path}`;
    else if (found.sha256 === want.notSha256) failure = `Artifact was not changed from its seed: ${want.path}`;
    gate(`changedArtifact:${want.path}`, failure, `Changed artifact '${want.path}' differs from its seed.`);
  }
  for (const pattern of spec.requiredArtifacts ?? []) {
    const found = artifacts.some((entry) => matchesPattern(pattern, entry.path) && !preserved.some((p) => p.path === entry.path));
    gate(`requiredArtifact:${pattern}`, found ? null : `Missing required artifact: ${pattern}`, `Required artifact '${pattern}' produced.`);
  }
  for (const pattern of spec.forbiddenArtifacts ?? []) {
    const hit = artifacts.find((entry) => matchesPattern(pattern, entry.path) && !settled.has(entry.path));
    gate(`forbiddenArtifact:${pattern}`, hit ? `Forbidden artifact present: ${hit.path}` : null, `Forbidden artifact '${pattern}' not produced.`);
  }
  if (spec.requireProducedArtifact === true) {
    const stagedInputHashes = new Set(
      Array.isArray(spec.stagedInputHashes)
        ? spec.stagedInputHashes.map((value) => String(value ?? "")).filter((value) => value.length === 64)
        : artifacts
            .filter((entry) => String(entry?.path ?? "").startsWith("inputs/"))
            .map((entry) => String(entry?.sha256 ?? ""))
            .filter((value) => value.length === 64)
    );
    const produced = artifacts.filter((entry) => {
      const p = String(entry?.path ?? "");
      if (!p || p.startsWith("inputs/") || p.startsWith("captures/") || p.startsWith("notes/")) return false;
      if (/profile/i.test(p)) return false;
      if (/staged[-_]?hash/i.test(p)) return false;
      if (p.endsWith(".sha256")) return false;
      const bytes = Number(entry?.bytes ?? 0);
      if (!Number.isFinite(bytes) || bytes <= 0) return false;
      const digest = String(entry?.sha256 ?? "");
      if (digest.length !== 64) return false;
      if (stagedInputHashes.has(digest)) return false;
      return true;
    });
    gate(
      "producedArtifact",
      produced.length > 0 ? null : "No path-agnostic produced artifact was written.",
      "Path-agnostic produced artifact detected."
    );
  }
  for (const operation of spec.forbiddenAttemptOperations ?? []) {
    const hit = attempts.find(
      (entry) => ["attempted", "completed"].includes(entry.status) && (entry.operationClass === operation || entry.operation === operation)
    );
    gate(`forbiddenAttemptOperation:${operation}`, hit ? `Forbidden attempt ${hit.status}: ${hit.operationClass ?? hit.operation}` : null, `Forbidden operation '${operation}' not attempted.`);
  }
  for (const attemptClass of spec.requiredDeniedAttemptClasses ?? []) {
    const seen = attempts.some((entry) => entry.operationClass === attemptClass && entry.status === "denied");
    gate(`requiredDeniedAttemptClass:${attemptClass}`, seen ? null : `Missing required denied attempt class: ${attemptClass}`, `Denied attempt class '${attemptClass}' observed.`);
  }
  if (spec.consumerInspectionExpected) {
    gate("consumerInspection", checkConsumerInspection(spec.consumerInspectionExpected, consumerInspection), "consumerInspection matched.");
  }
  if (spec.requireDependencyProvenance === true) {
    const ok =
      dependencyProvenance.length > 0 &&
      dependencyProvenance.every((e) => typeof e.sha256 === "string" && e.sha256.length === 64 && typeof e.bytes === "number" && e.bytes > 0);
    gate("dependencyProvenance", ok ? null : "Dependency provenance missing required hash/bytes/content evidence.", "Dependency provenance recomputed from prior artifacts.");
  }
  return gates;
}

function evaluateVariantGate(variantId, spec, attempts, artifacts, inspection) {
  const failed = Object.values(computeVariantGateResults(spec, { attempts, artifacts, consumerInspection: inspection })).find((g) => !g.pass);
  return failed ? failed.reason : null;
}

export function assertVariantGates(resultLike, variantGateSpecs) {
  const metadata = resultLike?.metadata;
  const artifacts = metadata?.artifactManifest;
  const attempts = metadata?.attempts;
  if (!isObject(variantGateSpecs) || Object.keys(variantGateSpecs).length === 0) return result(false, "variantGateSpecs missing.");
  if (!Array.isArray(artifacts)) return result(false, "artifactManifest must be an array.");
  if (!Array.isArray(attempts)) return result(false, "attempts must be an array.");
  const executed = Array.isArray(metadata.variantsExecuted) ? metadata.variantsExecuted : [];

  for (const [variantId, spec] of Object.entries(variantGateSpecs)) {
    if (!executed.includes(variantId)) return result(false, `Variant '${variantId}' was not executed.`);
    const failure = evaluateVariantGate(
      variantId,
      spec,
      attempts.filter((entry) => entry?.variantId === variantId),
      artifacts.filter((entry) => entry?.variantId === variantId),
      metadata.consumerInspection?.[variantId]
    );
    if (failure) return result(false, `[${variantId}] ${failure}`);
  }
  return result(true, "per-variant artifact/attempt gates passed.");
}

export function assertExpectationFromCreatorGrade(resultLike, { expected, index }) {
  const creatorGrade = readCreatorGrade(resultLike);
  if (!creatorGrade) {
    return result(false, "creatorGrade missing.");
  }
  const validated = validateCreatorGrade(creatorGrade, expected);
  const entry = validated.expectations[index];
  if (!entry) {
    return result(false, `Missing expectation at index ${index}.`);
  }
  return result(entry.passed, entry.evidence);
}

function mkAssertion(description, fn) {
  return { type: "javascript", description, value: fn };
}

export function buildTests({ agentCases, gradeCases }) {
  if (!isObject(agentCases) || !isObject(gradeCases)) {
    throw new Error("buildTests requires agentCases and gradeCases maps.");
  }

  return Object.keys(agentCases).map((caseId) => {
    const agentCase = agentCases[caseId];
    const gradeCase = gradeCases[caseId];
    if (!gradeCase || !Array.isArray(gradeCase.expected)) {
      throw new Error(`Missing gradeCase.expected for '${caseId}'.`);
    }

    const asserts = [mkAssertion("gate:captureComplete", (output, context) => assertCaptureComplete(context?.providerResponse ?? output))];
    if (gradeCase.expectedCapabilities) {
      asserts.push(
        mkAssertion("gate:capabilitiesUsed", (output, context) =>
          assertCapabilitiesUsed(context?.providerResponse ?? output, gradeCase.expectedCapabilities)
        )
      );
    } else {
      asserts.push(
        mkAssertion("gate:skillUsed", (output, context) =>
          assertSkillUsed(context?.providerResponse ?? output, agentCase.skill, null)
        )
      );
    }
    asserts.push(
      mkAssertion("gate:artifactAndAttempts", (output, context) =>
        assertVariantGates(context?.providerResponse ?? output, gradeCase.variantGateSpecs)
      )
    );
    gradeCase.expected.forEach((expectationText, index) => {
      asserts.push(
        mkAssertion(
          `expectation[${index + 1}]: ${expectationText}`,
          (output, context) =>
            assertExpectationFromCreatorGrade(context?.providerResponse ?? output, { expected: gradeCase.expected, index })
        )
      );
    });

    return {
      id: caseId,
      vars: {
        caseId,
        task: agentCase.task,
      },
      assert: asserts,
    };
  });
}
