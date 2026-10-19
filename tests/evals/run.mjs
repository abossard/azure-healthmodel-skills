import { access, chmod, lstat, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WAZA_ROOT = path.join(REPO_ROOT, "tests", "evals", "waza");
const EVAL_PATH = path.join(WAZA_ROOT, "eval.yaml");
const SOURCE_MANIFEST_PATH = path.join(WAZA_ROOT, "manifests", "source-to-native.manifest.json");
const BLOCKED_MANIFEST_PATH = path.join(WAZA_ROOT, "manifests", "blocked.manifest.json");
const DEFAULT_RESULTS_DIR = path.join(REPO_ROOT, ".waza", "results");
const DEFAULT_RESULT_PATH = path.join(DEFAULT_RESULTS_DIR, "latest", "result.json");
const DEFAULT_REPORT_PATH = path.join(REPO_ROOT, ".waza", "report.json");
const DEFAULT_JUNIT_PATH = path.join(REPO_ROOT, ".waza", "report.junit.xml");
const DEFAULT_SELECTION_PATH = path.join(REPO_ROOT, ".waza", "selection.json");
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

class CommandError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const flags = {};
  const extras = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      extras.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = flags[key] ?? "true";
      continue;
    }
    if (flags[key] === undefined) {
      flags[key] = next;
    } else if (Array.isArray(flags[key])) {
      flags[key].push(next);
    } else {
      flags[key] = [flags[key], next];
    }
    i += 1;
  }
  return { flags, extras };
}

function assertAllowedFlags(flags, allowed, mode) {
  const allow = new Set(allowed);
  const unknown = Object.keys(flags).filter((key) => !allow.has(key));
  if (unknown.length > 0) {
    throw new CommandError(`Unknown flag(s) for '${mode}': ${unknown.map((key) => `--${key}`).join(", ")}`);
  }
}

function parseCaseIds(value) {
  if (value === undefined || value === null) return null;
  const tokens = String(value).split(",").map((item) => item.trim());
  if (tokens.some((item) => item.length === 0)) {
    throw new CommandError("Invalid --case value. Use comma-separated non-empty IDs.");
  }
  const unique = new Set(tokens);
  if (unique.size !== tokens.length) {
    throw new CommandError("Invalid --case value. Duplicate IDs are not allowed.");
  }
  return tokens;
}

function parsePort(value, fallback = 31550) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new CommandError(`Invalid --port '${value}'. Expected integer 1-65535.`);
  }
  return parsed;
}

function coerceArrayValue(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensurePrivateDirChain(dirPath, options = {}) {
  const resolvedDir = path.resolve(dirPath);
  const stateRoot = path.resolve(options.stateRoot ?? path.join(REPO_ROOT, ".waza"));

  if (isWithin(stateRoot, resolvedDir)) {
    const rootInfo = await lstat(stateRoot).catch((error) => {
      if (error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!rootInfo) {
      await mkdir(stateRoot, { mode: PRIVATE_DIR_MODE });
    } else if (rootInfo.isSymbolicLink()) {
      throw new CommandError(`Refusing symlinked state root: ${stateRoot}`);
    } else if (!rootInfo.isDirectory()) {
      throw new CommandError(`Expected state root directory: ${stateRoot}`);
    }
    const rootAfter = await lstat(stateRoot);
    if (rootAfter.isSymbolicLink()) {
      throw new CommandError(`Refusing symlinked state root: ${stateRoot}`);
    }
    await chmod(stateRoot, PRIVATE_DIR_MODE);
    const rel = path.relative(stateRoot, resolvedDir);
    if (!rel) return;
    const segments = rel.split(path.sep).filter(Boolean);
    let current = stateRoot;
    for (const segment of segments) {
      current = path.join(current, segment);
      const info = await lstat(current).catch((error) => {
        if (error && error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) {
        await mkdir(current, { mode: PRIVATE_DIR_MODE });
      } else if (info.isSymbolicLink()) {
        throw new CommandError(`Refusing symlinked state directory segment: ${current}`);
      } else if (!info.isDirectory()) {
        throw new CommandError(`Expected directory but found file: ${current}`);
      }
      const currentInfo = await lstat(current);
      if (currentInfo.isSymbolicLink()) {
        throw new CommandError(`Refusing symlinked state directory segment: ${current}`);
      }
      await chmod(current, PRIVATE_DIR_MODE);
    }
    return;
  }

  const info = await stat(resolvedDir).catch((error) => {
    if (error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) {
    await mkdir(resolvedDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    await chmod(resolvedDir, PRIVATE_DIR_MODE);
    return;
  }
  if (!info.isDirectory()) {
    throw new CommandError(`Expected directory but found file: ${resolvedDir}`);
  }
}

async function writePrivateFileAtomic(filePath, content, options = {}) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  await ensurePrivateDirChain(dir, options);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  const handle = await open(tmpPath, "w", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(tmpPath, resolved);
  } catch (error) {
    await unlink(tmpPath).catch((cleanupError) => {
      if (cleanupError && cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
  await chmod(resolved, PRIVATE_FILE_MODE);
}

async function writeJsonPrivate(filePath, value, options = {}) {
  await writePrivateFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function classifyStatus(rawStatus) {
  const status = String(rawStatus ?? "").toLowerCase();
  if (status === "pass" || status === "passed" || status === "success" || status === "completed") return "pass";
  if (status === "fail" || status === "failed") return "fail";
  if (status === "error") return "error";
  if (status === "skipped" || status === "blocked" || status === "unrun" || status === "cancelled") return "unrun";
  return null;
}

async function resolveWazaBinary(explicitPath = null, deps = {}) {
  const runCommandCapture = deps.runCommandCapture ?? defaultRunCommandCapture;
  const candidate = explicitPath ?? process.env.WAZA_BIN ?? "waza";
  if (candidate === "waza") {
    const probe = await runCommandCapture("waza", ["--version"]);
    if (probe.code !== 0) {
      throw new CommandError(
        "Unable to resolve Waza binary. Set WAZA_BIN to a valid binary path or install 'waza' on PATH."
      );
    }
    return { command: "waza", displayPath: "waza" };
  }
  const resolved = path.resolve(String(candidate));
  const info = await stat(resolved).catch(() => null);
  if (!info || !info.isFile()) throw new CommandError(`Waza binary not found at '${resolved}'.`);
  return { command: resolved, displayPath: resolved };
}

async function defaultRunCommandCapture(command, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForTcpServer({ host, port, timeoutMs = 4000 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new CommandError(`Timed out waiting for JSON-RPC server on ${host}:${port}`);
}

async function invokeRpcValidate({ binaryCommand, evalPath, deps = {} }) {
  const host = "127.0.0.1";
  const port = await (deps.getFreePort ?? getFreePort)();
  const spawnFn = deps.spawn ?? spawn;
  const child = spawnFn(binaryCommand, ["serve", "--tcp", `${host}:${port}`, "--no-update-check"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  try {
    await (deps.waitForTcpServer ?? waitForTcpServer)({ host, port, timeoutMs: 6000 });
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        const request = {
          jsonrpc: "2.0",
          id: 1,
          method: "eval.validate",
          params: { path: evalPath },
        };
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.setEncoding("utf8");
      let payload = "";
      socket.on("data", (chunk) => {
        payload += chunk;
        const lines = payload.split("\n");
        payload = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.error) {
              reject(new CommandError(`eval.validate RPC error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`));
              socket.end();
              return;
            }
            resolve(parsed.result ?? {});
            socket.end();
            return;
          } catch (error) {
            reject(new CommandError(`Invalid JSON-RPC response: ${error.message}`));
            socket.end();
            return;
          }
        }
      });
      socket.on("error", (error) => reject(new CommandError(`JSON-RPC socket error: ${error.message}`)));
    });
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {}
    await new Promise((resolve) => {
      child.once("close", () => resolve());
      setTimeout(() => resolve(), 1000).unref();
    });
  }
}

function assertValidateResult(result) {
  if (result?.valid === true) return;
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  const preview = errors.slice(0, 12).map((entry) => `- ${entry}`).join("\n");
  throw new CommandError(
    `Native eval.validate failed with ${errors.length} error(s).\n${preview}`
  );
}

function deriveTaskIdsFromMapping(entry) {
  if (Array.isArray(entry.variantTaskIds)) return entry.variantTaskIds.map(String);
  if (Array.isArray(entry.taskIds)) return entry.taskIds.map(String);
  if (entry.taskId) return [String(entry.taskId)];
  if (entry.taskPath) return [path.basename(String(entry.taskPath), ".yaml")];
  return [];
}

function getSourceMappingEntries(sourceManifest) {
  if (Array.isArray(sourceManifest?.sourceToVariantTasks)) return sourceManifest.sourceToVariantTasks;
  if (Array.isArray(sourceManifest?.mappings)) return sourceManifest.mappings;
  return [];
}

function buildMapping(sourceManifest) {
  const mappings = getSourceMappingEntries(sourceManifest);
  const bySource = new Map();
  for (const entry of mappings) {
    const sourceId = String(entry?.sourceId ?? "");
    if (!sourceId) continue;
    const ids = deriveTaskIdsFromMapping(entry);
    if (ids.length === 0) continue;
    const bucket = bySource.get(sourceId) ?? new Set();
    for (const id of ids) bucket.add(id);
    bySource.set(sourceId, bucket);
  }
  return bySource;
}

function extractBlockedSourceReasons(blockedManifest) {
  const sourceReasons = new Map();
  if (Array.isArray(blockedManifest?.blockedTasks)) {
    for (const entry of blockedManifest.blockedTasks) {
      const sourceId = String(entry?.sourceId ?? "");
      if (!sourceId) continue;
      const reasons = sourceReasons.get(sourceId) ?? new Set();
      if (Array.isArray(entry.readinessReasons)) {
        for (const reason of entry.readinessReasons) reasons.add(String(reason));
      }
      if (typeof entry.safetyReason === "string" && entry.safetyReason.length > 0) {
        reasons.add(entry.safetyReason);
      }
      if (typeof entry.reason === "string" && entry.reason.length > 0) {
        reasons.add(entry.reason);
      }
      sourceReasons.set(sourceId, reasons);
    }
    return sourceReasons;
  }

  if (Array.isArray(blockedManifest?.blocked)) {
    for (const entry of blockedManifest.blocked) {
      const sourceId = String(entry?.id ?? "");
      if (!sourceId) continue;
      const reasons = sourceReasons.get(sourceId) ?? new Set();
      if (typeof entry.reason === "string" && entry.reason.length > 0) {
        reasons.add(entry.reason);
      }
      sourceReasons.set(sourceId, reasons);
    }
  }
  return sourceReasons;
}

function buildSelection({ sourceManifest, requestedSourceIds }) {
  const bySource = buildMapping(sourceManifest);
  const allSourceIds = [...bySource.keys()].sort();
  const selectedSourceIds = requestedSourceIds ?? allSourceIds;
  const selectedSet = new Set(selectedSourceIds);
  if (selectedSet.size !== selectedSourceIds.length) {
    throw new CommandError("Selected source IDs contain duplicates.");
  }
  const unknown = selectedSourceIds.filter((id) => !bySource.has(id));
  if (unknown.length > 0) {
    throw new CommandError(`Unknown selected source ID(s): ${unknown.join(", ")}`);
  }
  const selectedTaskIds = [];
  for (const sourceId of selectedSourceIds) {
    for (const taskId of bySource.get(sourceId)) selectedTaskIds.push(taskId);
  }
  return { bySource, selectedSourceIds, selectedTaskIds };
}

function extractTaskOutcomes(resultPayload) {
  const candidates = [
    resultPayload?.tasks,
    resultPayload?.results?.tasks,
    resultPayload?.task_outcomes,
    resultPayload?.results?.task_outcomes,
  ];
  const list = candidates.find((value) => Array.isArray(value)) ?? [];
  return list
    .map((entry) => {
      const testId = entry?.test_id ?? entry?.testId ?? entry?.task_id ?? entry?.id ?? null;
      const status = entry?.status ?? entry?.result?.status ?? null;
      return testId && status ? { testId: String(testId), status: String(status) } : null;
    })
    .filter(Boolean);
}

function buildSourceCoverageReport({ selectedSourceIds, mappingBySource, blockedManifest, resultPayload }) {
  const blockedMap = extractBlockedSourceReasons(blockedManifest);
  const outcomes = new Map(extractTaskOutcomes(resultPayload).map((entry) => [entry.testId, entry.status]));
  const cases = selectedSourceIds.map((sourceId) => {
    if (blockedMap.has(sourceId)) {
      const reasons = [...blockedMap.get(sourceId)];
      return {
        id: sourceId,
        state: "blocked",
        reason: reasons.join(" | "),
        requiredTaskIds: [...(mappingBySource.get(sourceId) ?? [])],
      };
    }
    const requiredTaskIds = [...(mappingBySource.get(sourceId) ?? [])];
    if (requiredTaskIds.length === 0) {
      return { id: sourceId, state: "error", reason: "missing-task-mapping", requiredTaskIds };
    }
    const missing = requiredTaskIds.filter((taskId) => !outcomes.has(taskId));
    if (missing.length > 0) {
      return { id: sourceId, state: "unrun", reason: `missing-native-result:${missing.join(",")}`, requiredTaskIds };
    }
    const normalized = requiredTaskIds.map((taskId) => classifyStatus(outcomes.get(taskId)));
    if (normalized.some((state) => state === null)) {
      return { id: sourceId, state: "error", reason: "unknown-native-status", requiredTaskIds };
    }
    if (normalized.some((state) => state === "error")) {
      return { id: sourceId, state: "error", reason: "native-task-error", requiredTaskIds };
    }
    if (normalized.some((state) => state === "fail")) {
      return { id: sourceId, state: "fail", reason: "native-task-failed", requiredTaskIds };
    }
    if (normalized.some((state) => state === "unrun")) {
      return { id: sourceId, state: "unrun", reason: "native-task-unrun", requiredTaskIds };
    }
    return { id: sourceId, state: "pass", reason: null, requiredTaskIds };
  });

  const totals = {
    tests: cases.length,
    failures: cases.filter((entry) => entry.state === "fail").length,
    errors: cases.filter((entry) => entry.state === "error").length,
    skipped: cases.filter((entry) => entry.state === "blocked" || entry.state === "unrun").length,
  };
  const nonSuccess = totals.failures > 0 || totals.errors > 0 || totals.skipped > 0;
  return { totals, nonSuccess, cases };
}

function buildJUnit(report) {
  const rows = report.cases
    .map((entry) => {
      if (entry.state === "pass") {
        return `    <testcase classname="waza" name="${escapeXml(entry.id)}"/>`;
      }
      if (entry.state === "fail") {
        return [
          `    <testcase classname="waza" name="${escapeXml(entry.id)}">`,
          `      <failure message="expectation failure">${escapeXml(entry.reason ?? "failed")}</failure>`,
          "    </testcase>",
        ].join("\n");
      }
      if (entry.state === "error") {
        return [
          `    <testcase classname="waza" name="${escapeXml(entry.id)}">`,
          `      <error message="runtime error">${escapeXml(entry.reason ?? "error")}</error>`,
          "    </testcase>",
        ].join("\n");
      }
      return [
        `    <testcase classname="waza" name="${escapeXml(entry.id)}">`,
        `      <skipped message="${escapeXml(entry.state)}">${escapeXml(entry.reason ?? entry.state)}</skipped>`,
        "    </testcase>",
      ].join("\n");
    })
    .join("\n");

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    `<testsuite name="waza-source-coverage" tests="${report.totals.tests}" failures="${report.totals.failures}" errors="${report.totals.errors}" skipped="${report.totals.skipped}">`,
    `  <properties><property name="nonSuccess" value="${report.nonSuccess ? "true" : "false"}"/></properties>`,
    rows,
    "</testsuite>",
    "",
  ].join("\n");
}

async function commandValidate({ wazaBin = null } = {}, deps = {}) {
  const runCommandCapture = deps.runCommandCapture ?? defaultRunCommandCapture;
  const invokeValidate = deps.invokeRpcValidate ?? invokeRpcValidate;
  const binary = await resolveWazaBinary(wazaBin, deps);

  await readJson(SOURCE_MANIFEST_PATH);
  await readJson(BLOCKED_MANIFEST_PATH);
  await access(EVAL_PATH);

  const runHelp = await runCommandCapture(binary.command, ["run", "--help"]);
  if (runHelp.code !== 0) {
    throw new CommandError(`Failed to read run help: ${runHelp.stderr || "unknown error"}`);
  }
  if (!runHelp.stdout.includes("--output") || !runHelp.stdout.includes("--reporter") || !runHelp.stdout.includes("--task")) {
    throw new CommandError("Waza run help is missing expected release flags (--output, --reporter, --task).");
  }

  const validation = await invokeValidate({
    binaryCommand: binary.command,
    evalPath: EVAL_PATH,
    deps,
  });
  assertValidateResult(validation);
  console.log(`Native eval.validate passed for ${path.relative(REPO_ROOT, EVAL_PATH)} using ${binary.displayPath}`);
}

async function commandRun({ caseIds = null, outputPath = DEFAULT_RESULT_PATH } = {}) {
  const resolvedOutput = path.resolve(outputPath);
  const stateRoot = path.resolve(path.join(REPO_ROOT, ".waza"));
  if (!isWithin(stateRoot, resolvedOutput)) {
    throw new CommandError(`Output path must stay under ${stateRoot}: ${resolvedOutput}`);
  }
  await ensurePrivateDirChain(path.dirname(resolvedOutput));
  const sourceManifest = await readJson(SOURCE_MANIFEST_PATH);
  const selection = buildSelection({ sourceManifest, requestedSourceIds: caseIds });
  await writeJsonPrivate(DEFAULT_SELECTION_PATH, {
    selectedSourceIds: selection.selectedSourceIds,
    selectedTaskIds: selection.selectedTaskIds,
    generatedAt: new Date().toISOString(),
  });
  throw new CommandError(
    `Run blocked before inference. No safety-admitted executable tasks are available. Selected source IDs: ${selection.selectedSourceIds.join(", ")}`
  );
}

async function commandReport({ resultPath = DEFAULT_RESULT_PATH, caseIds = null, outJson = DEFAULT_REPORT_PATH, outJunit = DEFAULT_JUNIT_PATH } = {}) {
  const [sourceManifest, blockedManifest] = await Promise.all([
    readJson(SOURCE_MANIFEST_PATH),
    readJson(BLOCKED_MANIFEST_PATH),
  ]);
  const selection = buildSelection({ sourceManifest, requestedSourceIds: caseIds });
  const resultPayload = await readJson(path.resolve(resultPath));
  const report = buildSourceCoverageReport({
    selectedSourceIds: selection.selectedSourceIds,
    mappingBySource: selection.bySource,
    blockedManifest,
    resultPayload,
  });
  const payload = {
    generatedAt: new Date().toISOString(),
    resultPath: path.resolve(resultPath),
    selectedSourceIds: selection.selectedSourceIds,
    selectedTaskIds: selection.selectedTaskIds,
    totals: report.totals,
    nonSuccess: report.nonSuccess,
    cases: report.cases,
  };
  await writeJsonPrivate(path.resolve(outJson), payload);
  await writePrivateFileAtomic(path.resolve(outJunit), buildJUnit(report));
  console.log(`Native report JSON: ${path.resolve(outJson)}`);
  console.log(`Native report JUnit: ${path.resolve(outJunit)}`);
  if (report.nonSuccess) {
    throw new CommandError("Native source coverage is non-success (failed, errored, blocked, or unrun selected sources).");
  }
}

async function commandView({ resultsDir = DEFAULT_RESULTS_DIR, port = 31550, wazaBin = null } = {}, deps = {}) {
  const binary = await resolveWazaBinary(wazaBin, deps);
  const resolvedRoot = path.resolve(resultsDir);
  const info = await stat(resolvedRoot).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new CommandError(`Results directory does not exist: ${resolvedRoot}`);
  }
  const spawnFn = deps.spawn ?? spawn;
  const child = spawnFn(
    binary.command,
    ["serve", "--http", "--no-browser", "--port", String(port), "--results-dir", resolvedRoot, "--no-update-check"],
    { cwd: REPO_ROOT, stdio: "inherit" }
  );
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || code === null) {
        resolve();
        return;
      }
      reject(new CommandError(`waza serve exited with code ${code}`));
    });
  });
}

export const __testOnly = {
  classifyStatus,
  deriveTaskIdsFromMapping,
  getSourceMappingEntries,
  extractBlockedSourceReasons,
  buildSelection,
  buildSourceCoverageReport,
  buildJUnit,
  assertValidateResult,
  ensurePrivateDirChain,
  writePrivateFileAtomic,
  writeJsonPrivate,
};

async function main() {
  const [mode = "validate", ...rest] = process.argv.slice(2);
  const { flags, extras } = parseArgs(rest);
  if (extras.length > 0) throw new CommandError(`Unexpected positional arguments: ${extras.join(", ")}`);
  const caseIds = parseCaseIds(flags.case ?? null);

  if (mode === "validate") {
    assertAllowedFlags(flags, ["waza-bin"], "validate");
    await commandValidate({ wazaBin: flags["waza-bin"] ?? null });
    return;
  }
  if (mode === "run") {
    assertAllowedFlags(flags, ["case", "output"], "run");
    await commandRun({ caseIds, outputPath: flags.output ?? DEFAULT_RESULT_PATH });
    return;
  }
  if (mode === "report") {
    assertAllowedFlags(flags, ["case", "result", "out-json", "out-junit"], "report");
    await commandReport({
      caseIds,
      resultPath: flags.result ?? DEFAULT_RESULT_PATH,
      outJson: flags["out-json"] ?? DEFAULT_REPORT_PATH,
      outJunit: flags["out-junit"] ?? DEFAULT_JUNIT_PATH,
    });
    return;
  }
  if (mode === "view") {
    assertAllowedFlags(flags, ["results-dir", "port", "waza-bin"], "view");
    await commandView({
      resultsDir: flags["results-dir"] ?? DEFAULT_RESULTS_DIR,
      port: parsePort(flags.port, 31550),
      wazaBin: flags["waza-bin"] ?? null,
    });
    return;
  }
  throw new CommandError(`Unknown mode '${mode}'. Use validate, run, report, or view.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    if (error instanceof CommandError) {
      console.error(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  });
}
