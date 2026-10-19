import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { ALLOWED_SCOPE } from "./workflow-suite.mjs";

const execFile = promisify(execFileCallback);
const ALLOWED_STATUSES = new Set(["ok", "empty", "partial", "denied", "error"]);
const SECRET_FIELD_PATTERN = /(secret|token|password|key|kubeconfig|appsettings|customer|authorization|connectionstring)/i;
const READ_ONLY_QUERY_PATTERN = /\b(update|delete|insert|create|alter|drop|set|grant|revoke|truncate|merge)\b/i;
const ARM_SEGMENT_PATTERN = /^[A-Za-z0-9._()-]+$/;
const RESOURCE_GRAPH_ALLOWED_TABLES = new Set(["resources", "resourcecontainers"]);

const OPERATION_REGISTRY = {
  "resource-graph.query": {
    params: ["query", "subscriptions", "resourceGroups", "top", "skipToken"],
    validate(parameters, scope) {
      if (!isNonEmptyString(parameters.query)) throw policyError("query_required", "query is required.");
      if (READ_ONLY_QUERY_PATTERN.test(parameters.query)) throw policyError("query_not_readonly", "query must be read-only.");
      if (parameters.top !== undefined || parameters.skipToken !== undefined) {
        throw policyError("parameter_not_supported", "top/skipToken are not supported for resource-graph.query live adapter.");
      }
      if (parameters.subscriptions !== undefined) {
        if (!Array.isArray(parameters.subscriptions) || parameters.subscriptions.length === 0) {
          throw policyError("subscriptions_shape", "subscriptions must be a non-empty array when provided.");
        }
        for (const subscriptionId of parameters.subscriptions) {
          if (normalizeCase(subscriptionId) !== normalizeCase(scope.subscriptionId)) {
            throw policyError("subscription_scope", "Requested subscription is outside allowed scope.");
          }
        }
      }
      if (parameters.resourceGroups !== undefined) {
        if (!Array.isArray(parameters.resourceGroups) || parameters.resourceGroups.length === 0) {
          throw policyError("resource_groups_shape", "resourceGroups must be a non-empty array when provided.");
        }
        const allowedGroups = new Set(scope.resourceGroups.map(normalizeCase));
        for (const group of parameters.resourceGroups) {
          if (!allowedGroups.has(normalizeCase(group))) {
            throw policyError("resource_group_scope", `resourceGroup '${group}' is outside allowed scope.`);
          }
        }
      }
    },
  },
  "monitor.metrics.read": {
    params: ["resourceId", "metricName", "aggregation", "timespan", "interval", "filter", "top", "nextLink"],
    validate(parameters, scope) {
      if (!isNonEmptyString(parameters.resourceId) || !isNonEmptyString(parameters.metricName)) {
        throw policyError("metrics_required", "resourceId and metricName are required.");
      }
      validateResourceId(parameters.resourceId, scope);
      if (!isNonEmptyString(parameters.timespan)) throw policyError("timespan_required", "timespan is required.");
      if (parameters.nextLink !== undefined) {
        validateNextLink(parameters.nextLink, scope);
      }
    },
  },
  "logs.query": {
    params: ["workspaceResourceId", "query", "timespan", "top", "skipToken"],
    validate(parameters, scope) {
      if (!isNonEmptyString(parameters.workspaceResourceId) || !isNonEmptyString(parameters.query)) {
        throw policyError("logs_required", "workspaceResourceId and query are required.");
      }
      parseArmResourceId(parameters.workspaceResourceId, {
        scope,
        providerNamespace: "Microsoft.OperationalInsights",
        rootType: "workspaces",
      });
      if (READ_ONLY_QUERY_PATTERN.test(parameters.query)) throw policyError("query_not_readonly", "query must be read-only.");
    },
  },
  "prom.query": {
    params: ["accountResourceId", "query", "time", "nextLink"],
    validate(parameters, scope) {
      if (!isNonEmptyString(parameters.accountResourceId) || !isNonEmptyString(parameters.query)) {
        throw policyError("prom_required", "accountResourceId and query are required.");
      }
      parseArmResourceId(parameters.accountResourceId, {
        scope,
        providerNamespace: "Microsoft.Monitor",
        rootType: "accounts",
      });
      if (READ_ONLY_QUERY_PATTERN.test(parameters.query)) throw policyError("query_not_readonly", "query must be read-only.");
      if (parameters.nextLink !== undefined) {
        validateNextLink(parameters.nextLink, scope);
      }
    },
  },
};

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nowIso() {
  return new Date().toISOString();
}

function policyError(code, message) {
  const error = new Error(message);
  error.kind = "policy";
  error.code = code;
  return error;
}

function captureError(code, message) {
  const error = new Error(message);
  error.kind = "capture";
  error.code = code;
  return error;
}

function mapRuntimeError(error) {
  if (error?.kind && error?.code) {
    return { kind: error.kind, code: error.code, message: error.message };
  }
  if (error?.name === "AbortError") {
    return { kind: "infrastructure", code: "cancelled", message: "Operation was cancelled." };
  }
  if (error?.code === "ENOENT") {
    return { kind: "infrastructure", code: "missing_file", message: error.message };
  }
  return {
    kind: "infrastructure",
    code: error?.code ?? "runtime_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function guardScope(scope) {
  if (!isObject(scope)) {
    throw new Error("scope must be an object.");
  }
  if (scope.subscriptionId !== ALLOWED_SCOPE.subscriptionId) {
    throw new Error("subscription scope is not allowed.");
  }
  if (!Array.isArray(scope.resourceGroups) || scope.resourceGroups.length === 0) {
    throw new Error("resourceGroups must be a non-empty array.");
  }
  const allowed = new Set(ALLOWED_SCOPE.resourceGroups);
  for (const group of scope.resourceGroups) {
    if (!allowed.has(group)) {
      throw new Error(`resource group '${group}' is not allowed.`);
    }
  }
}

function validateResourceId(resourceId, scope) {
  parseArmResourceId(resourceId, { scope });
}

function normalizeCase(value) {
  return String(value ?? "").trim().toLowerCase();
}

function parseArmResourceId(resourceId, { scope, providerNamespace = null, rootType = null } = {}) {
  if (!isNonEmptyString(resourceId)) {
    throw policyError("resource_id_required", "resourceId must be a non-empty string.");
  }
  const normalized = resourceId.replaceAll("\\", "/");
  if (/[?#%]/.test(normalized)) {
    throw policyError("resource_id_shape", "resourceId must not include query, fragment, or encoded path segments.");
  }
  const match = normalized.match(
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/([^/]+)\/(.+)$/i
  );
  if (!match) {
    throw policyError("resource_id_shape", "resourceId must be an Azure resource ID under subscriptions/resourceGroups/providers.");
  }
  const [, subscriptionId, resourceGroup, provider, suffix] = match;
  if (![subscriptionId, resourceGroup, provider].every((entry) => ARM_SEGMENT_PATTERN.test(entry))) {
    throw policyError("resource_id_shape", "resourceId contains unsupported characters.");
  }
  const suffixSegments = suffix.split("/");
  if (suffixSegments.length < 2 || suffixSegments.length % 2 !== 0) {
    throw policyError("resource_id_shape", "resourceId must contain type/name pairs only.");
  }
  if (!suffixSegments.every((segment) => ARM_SEGMENT_PATTERN.test(segment))) {
    throw policyError("resource_id_shape", "resourceId contains unsupported characters.");
  }
  if (scope) {
    if (normalizeCase(subscriptionId) !== normalizeCase(scope.subscriptionId)) {
      throw policyError("resource_id_scope", "resourceId subscription is outside allowed scope.");
    }
    const allowedGroups = new Set(scope.resourceGroups.map(normalizeCase));
    if (!allowedGroups.has(normalizeCase(resourceGroup))) {
      throw policyError("resource_group_scope", "resourceId resource group is outside allowed scope.");
    }
  }
  if (providerNamespace && normalizeCase(provider) !== normalizeCase(providerNamespace)) {
    throw policyError("resource_provider_scope", `resourceId provider must be ${providerNamespace}.`);
  }
  if (rootType && normalizeCase(suffixSegments[0]) !== normalizeCase(rootType)) {
    throw policyError("resource_type_scope", `resourceId root type must be ${rootType}.`);
  }
  return {
    resourceId: normalized,
    subscriptionId,
    resourceGroup,
    provider,
    typeSegments: suffixSegments.filter((_, index) => index % 2 === 0),
    nameSegments: suffixSegments.filter((_, index) => index % 2 === 1),
  };
}

function validateNextLink(nextLink, scope) {
  if (!isNonEmptyString(nextLink)) {
    throw policyError("next_link_shape", "nextLink must be a non-empty string.");
  }
  let parsed;
  try {
    parsed = new URL(nextLink);
  } catch {
    throw policyError("next_link_invalid", "nextLink is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw policyError("next_link_protocol", "nextLink must use https.");
  }
  if (parsed.hostname !== "management.azure.com") {
    throw policyError("next_link_host", "nextLink host is not allowed.");
  }
  const decodedPath = decodeURIComponent(parsed.pathname);
  if (decodedPath.includes("..")) {
    throw policyError("next_link_traversal", "nextLink path traversal is not allowed.");
  }
  const expectedPrefix = `/subscriptions/${scope.subscriptionId}/`;
  if (!normalizeCase(decodedPath).startsWith(normalizeCase(expectedPrefix))) {
    throw policyError("next_link_scope", "nextLink subscription is outside allowed scope.");
  }
  const rgSegment = decodedPath.match(/\/resourceGroups\/([^/]+)/i)?.[1] ?? null;
  if (rgSegment) {
    const allowedGroups = new Set(scope.resourceGroups.map(normalizeCase));
    if (!allowedGroups.has(normalizeCase(rgSegment))) {
      throw policyError("next_link_scope", "nextLink resource group is outside allowed scope.");
    }
  }
}

function buildScopedResourceGraphQuery(query, scope, resourceGroups = null) {
  const text = String(query ?? "").trim();
  if (!text) throw policyError("query_required", "query is required.");
  if (/\b(union|join)\b/i.test(text)) {
    throw policyError("query_not_allowed", "resource-graph.query does not allow union/join.");
  }
  const firstSegment = text.split("|", 1)[0].trim();
  const tableMatch = firstSegment.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!tableMatch) {
    throw policyError("query_shape", "resource-graph.query must start with an allowed table name.");
  }
  const table = normalizeCase(tableMatch[1]);
  if (!RESOURCE_GRAPH_ALLOWED_TABLES.has(table)) {
    throw policyError("query_scope", `resource-graph.query table '${table}' is not allowed.`);
  }
  const groups = Array.isArray(resourceGroups) && resourceGroups.length > 0 ? resourceGroups : scope.resourceGroups;
  const escapedGroups = groups.map((group) => `'${String(group).replaceAll("'", "''")}'`).join(", ");
  const escapedSub = String(scope.subscriptionId).replaceAll("'", "''");
  const tail = text.slice(firstSegment.length).trim();
  const predicate = `| where subscriptionId =~ '${escapedSub}' and resourceGroup in~ (${escapedGroups})`;
  return `${tableMatch[1]} ${predicate}${tail ? ` ${tail}` : ""}`.trim();
}

function assertClosedOperationInput(input) {
  if (!isObject(input)) throw policyError("input_shape", "input must be an object.");
  const keys = Object.keys(input).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["operation", "parameters"])) {
    throw policyError("input_shape", "input must contain only operation and parameters.");
  }
  if (!isNonEmptyString(input.operation)) throw policyError("operation_shape", "operation must be a non-empty string.");
  if (!isObject(input.parameters)) throw policyError("parameters_shape", "parameters must be an object.");
  const spec = OPERATION_REGISTRY[input.operation];
  if (!spec) throw policyError("operation_not_allowed", `Operation '${input.operation}' is not allowed.`);
  const unknown = Object.keys(input.parameters).filter((key) => !spec.params.includes(key));
  if (unknown.length > 0) throw policyError("parameter_not_allowed", `Unexpected parameter(s): ${unknown.join(", ")}`);
  return spec;
}

function buildPromQueryUrl(endpoint, query, time = null) {
  if (!isNonEmptyString(endpoint)) {
    throw policyError("prom_endpoint_missing", "Prometheus query endpoint is not configured.");
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw policyError("prom_endpoint_invalid", "Prometheus endpoint is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw policyError("prom_endpoint_invalid", "Prometheus endpoint must use https.");
  }
  parsed.pathname = "/api/v1/query";
  parsed.search = "";
  parsed.searchParams.set("query", query);
  if (isNonEmptyString(time)) {
    parsed.searchParams.set("time", time);
  }
  return parsed.toString();
}

function operationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["operation", "parameters"],
    properties: {
      operation: {
        type: "string",
        enum: Object.keys(OPERATION_REGISTRY),
      },
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          subscriptions: { type: "array", items: { type: "string" } },
          resourceGroups: { type: "array", items: { type: "string" } },
          top: { type: "number" },
          skipToken: { type: "string" },
          resourceId: { type: "string" },
          metricName: { type: "string" },
          aggregation: { type: "string" },
          timespan: { type: "string" },
          interval: { type: "string" },
          filter: { type: "string" },
          nextLink: { type: "string" },
          workspaceResourceId: { type: "string" },
          accountResourceId: { type: "string" },
          time: { type: "string" },
        },
      },
    },
  };
}

function rehearsalSchema() {
  return {
    type: "object",
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["action", "packagePath"],
        properties: {
          action: { type: "string", const: "inspect" },
          packagePath: { type: "string", minLength: 1 },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["action", "packagePath", "operation", "claimedTargets"],
        properties: {
          action: { type: "string", const: "execute" },
          packagePath: { type: "string", minLength: 1 },
          operation: { type: "string", minLength: 1 },
          claimedTargets: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    ],
  };
}

function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }
  if (!isObject(value)) {
    return value;
  }
  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      continue;
    }
    projected[key] = sanitizeValue(child);
  }
  return projected;
}

function detectOutcomeStatus(data, preferredStatus = null) {
  if (preferredStatus && ALLOWED_STATUSES.has(preferredStatus)) {
    return preferredStatus;
  }
  if (data === null || data === undefined) return "empty";
  if (Array.isArray(data) && data.length === 0) return "empty";
  if (isObject(data)) {
    if (Array.isArray(data.value) && data.value.length === 0) return "empty";
    if (Array.isArray(data.rows) && data.rows.length === 0) return "empty";
    if (Array.isArray(data.tables) && data.tables.length > 0) {
      const rows = data.tables.flatMap((table) => Array.isArray(table?.rows) ? table.rows : []);
      if (rows.length === 0) return "empty";
    }
    if (Array.isArray(data.result) && data.result.length === 0) return "empty";
  }
  return "ok";
}

function normalizeEnvelopeStatus(status, fallbackData = null) {
  if (!ALLOWED_STATUSES.has(status)) {
    return detectOutcomeStatus(fallbackData, "error");
  }
  if (status === "ok") return detectOutcomeStatus(fallbackData, "ok");
  return status;
}

function normalizeReceiptError(error) {
  if (!error) return null;
  return {
    kind: error.kind ?? "infrastructure",
    code: error.code ?? "unknown",
    message: error.message ?? "Unknown error.",
  };
}

function buildReceipt({
  suiteId,
  caseId,
  validationId,
  mode,
  actor,
  operation,
  scope,
  request,
  status,
  response,
  error,
  sourceCapture,
  observationTime = null,
  startedAt,
  completedAt,
  attemptId = null,
}) {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    attemptId,
    suiteId,
    caseId,
    validationId,
    mode,
    actor,
    operation,
    scope,
    request,
    startedAt,
    completedAt,
    observationTime,
    status,
    response,
    error: normalizeReceiptError(error),
    sourceCapture: sourceCapture ?? null,
    provenance: "azure-readonly-tool",
  };
}

async function persistReceipt({ evidenceRoot, caseId, operation, payload }) {
  const dir = path.resolve(evidenceRoot, caseId);
  await mkdir(dir, { recursive: true });
  const fileName = `${Date.now()}-${operation.replaceAll(".", "_")}-${randomUUID()}.json`;
  const absolutePath = path.join(dir, fileName);
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(absolutePath, serialized, "utf8");
  return {
    path: path.posix.join(caseId, fileName),
    sha256: sha256(serialized),
  };
}

function getCaptureEntries(captureSet, caseId) {
  if (!captureSet?.entries || !Array.isArray(captureSet.entries)) {
    throw captureError("capture_entries_missing", "captureSet.entries is required.");
  }
  return captureSet.entries.filter((entry) => entry.caseIds?.includes(caseId) || entry.caseIds?.includes("*"));
}

function parseCaptureEntry(entry) {
  try {
    return JSON.parse(entry.content);
  } catch {
    return null;
  }
}

function normalizeRecordedPayload({ payload, entry }) {
  const raw = payload?.result ?? payload?.response ?? payload?.data ?? null;
  const projected = sanitizeValue(raw);
  const status =
    payload?.error
      ? "partial"
      : detectOutcomeStatus(projected, payload?.status ?? null);
  return {
    status,
    data: projected,
    observationTime: payload?.completedAt ?? payload?.collectedAt ?? null,
    error: payload?.error ? { kind: "capture", code: "recorded_partial", message: "Capture includes an error payload." } : null,
    sourceCapture: {
      path: entry.path,
      sha256: entry.sha256,
    },
  };
}

function canonicalizeRecordedRequest(operation, parameters, scope) {
  if (operation === "resource-graph.query") {
    return {
      operation,
      query: String(parameters.query ?? "").trim(),
      subscriptions: (parameters.subscriptions ?? [scope.subscriptionId]).map((value) => normalizeCase(value)).sort(),
      resourceGroups: (parameters.resourceGroups ?? scope.resourceGroups).map((value) => normalizeCase(value)).sort(),
    };
  }
  if (operation === "logs.query") {
    return {
      operation,
      workspaceResourceId: normalizeCase(parameters.workspaceResourceId),
      query: String(parameters.query ?? "").trim(),
      timespan: String(parameters.timespan ?? "").trim(),
    };
  }
  if (operation === "prom.query") {
    return {
      operation,
      accountResourceId: normalizeCase(parameters.accountResourceId),
      query: String(parameters.query ?? "").trim(),
      time: parameters.time === undefined || parameters.time === null ? null : String(parameters.time).trim(),
    };
  }
  if (operation === "monitor.metrics.read") {
    return {
      operation,
      resourceId: normalizeCase(parameters.resourceId),
      metricName: String(parameters.metricName ?? "").trim(),
      timespan: String(parameters.timespan ?? "").trim(),
      aggregation: parameters.aggregation === undefined ? null : String(parameters.aggregation).trim(),
      interval: parameters.interval === undefined ? null : String(parameters.interval).trim(),
      filter: parameters.filter === undefined ? null : String(parameters.filter).trim(),
    };
  }
  return { operation };
}

function extractRecordedRequest(payload, operation, scope) {
  const requestPayload = payload?.request ?? {};
  if (operation === "resource-graph.query") {
    return canonicalizeRecordedRequest(
      operation,
      {
        query: payload?.query ?? requestPayload?.query ?? "",
        subscriptions: requestPayload?.subscriptions ?? [scope.subscriptionId],
        resourceGroups: requestPayload?.resourceGroups ?? scope.resourceGroups,
      },
      scope
    );
  }
  if (operation === "logs.query") {
    return canonicalizeRecordedRequest(
      operation,
      {
        workspaceResourceId:
          requestPayload?.workspaceResourceId ?? requestPayload?.workspace ?? payload?.workspaceResourceId ?? "",
        query: payload?.query ?? requestPayload?.query ?? "",
        timespan: requestPayload?.timespan ?? payload?.timeWindow ?? "",
      },
      scope
    );
  }
  if (operation === "prom.query") {
    return canonicalizeRecordedRequest(
      operation,
      {
        accountResourceId: requestPayload?.accountResourceId ?? payload?.accountResourceId ?? "",
        query: payload?.query ?? requestPayload?.query ?? requestPayload?.queryText ?? "",
        time: requestPayload?.time ?? payload?.time ?? null,
      },
      scope
    );
  }
  if (operation === "monitor.metrics.read") {
    return canonicalizeRecordedRequest(
      operation,
      {
        resourceId: requestPayload?.resourceId ?? requestPayload?.path ?? payload?.resourceId ?? "",
        metricName: requestPayload?.metricName ?? requestPayload?.query?.metricnames ?? payload?.metricName ?? "",
        timespan: requestPayload?.timespan ?? payload?.timeWindow ?? "",
        aggregation: requestPayload?.aggregation ?? null,
        interval: requestPayload?.interval ?? null,
        filter: requestPayload?.filter ?? null,
      },
      scope
    );
  }
  return { operation };
}

function isCaptureEntryEligible(entry) {
  return entry.kind === "capture" && entry.visibility === "agent";
}

function matchRecordedEntry({ entry, request, scope }) {
  const payload = parseCaptureEntry(entry);
  if (!payload) return false;
  const expected = canonicalizeRecordedRequest(request.operation, request.parameters, scope);
  const actual = extractRecordedRequest(payload, request.operation, scope);
  return JSON.stringify(expected) === JSON.stringify(actual);
}

async function defaultResolveRecorded({ request, captureSet, caseId, scope }) {
  const entries = getCaptureEntries(captureSet, caseId).filter((entry) => isCaptureEntryEligible(entry));
  const matching = entries.filter((entry) => matchRecordedEntry({ entry, request, scope }));
  if (matching.length === 0) {
    throw captureError("capture_not_found", `No recorded capture matched ${request.operation}.`);
  }
  const uniqueHashes = new Set(matching.map((entry) => entry.sha256));
  if (uniqueHashes.size > 1) {
    throw captureError("capture_ambiguous", `Recorded captures are ambiguous for ${request.operation}.`);
  }
  const selected = matching[0];
  const payload = parseCaptureEntry(selected);
  if (!payload) {
    throw captureError("capture_parse_failed", `Capture '${selected.path}' is not valid JSON.`);
  }
  return normalizeRecordedPayload({ payload, entry: selected });
}

async function defaultProcessRunner(command, args, { signal } = {}) {
  const { stdout, stderr } = await execFile(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  return { stdout, stderr, exitCode: 0 };
}

function classifyTransportError(error) {
  const message = String(error?.stderr ?? error?.message ?? "");
  if (/authorization|forbidden|unauthorized|insufficient/i.test(message)) {
    return { kind: "access", code: "authorization_failed", message };
  }
  if (/not found|404/i.test(message)) {
    return { kind: "access", code: "not_found", message };
  }
  if (error?.name === "AbortError") {
    return { kind: "infrastructure", code: "cancelled", message: "Operation was cancelled." };
  }
  return { kind: "infrastructure", code: error?.code ?? "transport_error", message };
}

function mapLiveInvokeError(error) {
  if (error?.kind === "policy") {
    return { status: "denied", error: mapRuntimeError(error) };
  }
  if (error?.kind === "capture") {
    return { status: "error", error: mapRuntimeError(error) };
  }
  return { status: "error", error: classifyTransportError(error) };
}

function extractResourceGroupFromRow(row) {
  const rgCandidate = row?.resourceGroup ?? row?.resourcegroup ?? null;
  if (isNonEmptyString(rgCandidate)) return normalizeCase(rgCandidate);
  const id = row?.id;
  if (isNonEmptyString(id)) {
    const matched = String(id).match(/\/resourcegroups\/([^/]+)/i);
    if (matched) return normalizeCase(matched[1]);
  }
  return null;
}

function enforceResourceGraphScope(response, scope) {
  if (!isObject(response) || !Array.isArray(response.data)) {
    return { response, status: "ok", scopeFiltered: false };
  }
  const allowed = new Set(scope.resourceGroups.map(normalizeCase));
  const filtered = [];
  let dropped = 0;
  for (const row of response.data) {
    const rowRg = extractResourceGroupFromRow(row);
    if (rowRg && !allowed.has(rowRg)) {
      dropped += 1;
      continue;
    }
    filtered.push(row);
  }
  return {
    response: {
      ...response,
      data: filtered,
      count: filtered.length,
    },
    status: dropped > 0 ? "partial" : "ok",
    scopeFiltered: dropped > 0,
  };
}

function resolvePromQueryEndpoint({ captureSet, caseId, accountResourceId, resolver }) {
  if (typeof resolver === "function") {
    return resolver({ captureSet, caseId, accountResourceId });
  }
  const targetAccountId = normalizeCase(accountResourceId);
  const entries = getCaptureEntries(captureSet, caseId).filter(
    (entry) => entry.kind === "schema" && entry.visibility === "host"
  );
  for (const entry of entries) {
    const payload = parseCaptureEntry(entry);
    if (!isObject(payload)) continue;
    const result = payload?.result;
    if (!isObject(result)) continue;
    const capturedAccountId = isNonEmptyString(result.id) ? normalizeCase(result.id) : null;
    if (!capturedAccountId || capturedAccountId !== targetAccountId) continue;
    const capturedType = isNonEmptyString(result.type) ? normalizeCase(result.type) : null;
    if (capturedType !== "microsoft.monitor/accounts") {
      throw policyError("prom_endpoint_invalid", "Prometheus account capture type is invalid.");
    }
    const endpoint = result?.properties?.metrics?.prometheusQueryEndpoint;
    if (!isNonEmptyString(endpoint)) {
      throw policyError("prom_endpoint_missing", "Prometheus endpoint is missing in matched host account capture.");
    }
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw policyError("prom_endpoint_invalid", "Prometheus endpoint in matched host account capture is not a valid URL.");
    }
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".prometheus.monitor.azure.com")) {
      throw policyError("prom_endpoint_invalid", "Prometheus endpoint in matched host account capture is outside allowed domain.");
    }
    return endpoint;
  }
  throw policyError("prom_endpoint_missing", "No registered Prometheus query endpoint for accountResourceId.");
}

async function invokeLiveOperation({ request, scope, signal }, deps = {}) {
  const processRunner = deps.processRunner ?? defaultProcessRunner;
  const operation = request.operation;
  const p = request.parameters;
  if (operation === "resource-graph.query") {
    const scopedQuery = buildScopedResourceGraphQuery(p.query, scope, p.resourceGroups);
    const args = [
      "graph",
      "query",
      "-q",
      scopedQuery,
      "--subscriptions",
      scope.subscriptionId,
      "--output",
      "json",
      "--only-show-errors",
    ];
    const { stdout } = await processRunner("az", args, { signal });
    const payload = JSON.parse(stdout);
    const scoped = enforceResourceGraphScope(payload, scope);
    return {
      ...scoped.response,
      status: scoped.status,
    };
  }
  if (operation === "monitor.metrics.read") {
    const args = [
      "monitor",
      "metrics",
      "list",
      "--resource",
      p.resourceId,
      "--metric",
      p.metricName,
      "--timespan",
      p.timespan,
      "--aggregation",
      p.aggregation ?? "Average",
      "--output",
      "json",
      "--only-show-errors",
    ];
    if (isNonEmptyString(p.interval)) args.push("--interval", p.interval);
    if (isNonEmptyString(p.filter)) args.push("--filter", p.filter);
    const { stdout } = await processRunner("az", args, { signal });
    return JSON.parse(stdout);
  }
  if (operation === "logs.query") {
    const args = [
      "monitor",
      "log-analytics",
      "query",
      "--workspace",
      p.workspaceResourceId,
      "--analytics-query",
      p.query,
      "--timespan",
      p.timespan,
      "--output",
      "json",
      "--only-show-errors",
    ];
    const { stdout } = await processRunner("az", args, { signal });
    return JSON.parse(stdout);
  }
  if (operation === "prom.query") {
    const endpoint = resolvePromQueryEndpoint({
      captureSet: deps.captureSet,
      caseId: deps.caseId,
      accountResourceId: p.accountResourceId,
      resolver: deps.resolvePromQueryEndpoint,
    });
    const url = buildPromQueryUrl(endpoint, p.query, p.time);
    const args = [
      "rest",
      "--method",
      "get",
      "--url",
      url,
      "--resource",
      "https://prometheus.monitor.azure.com",
      "--output",
      "json",
      "--only-show-errors",
    ];
    const { stdout } = await processRunner("az", args, { signal });
    return JSON.parse(stdout);
  }
  throw policyError("operation_not_allowed", `Operation '${operation}' is not allowed.`);
}

function projectLiveResponse(response, scope) {
  if (!isObject(response)) {
    return { status: "empty", data: null, observationTime: null, error: null };
  }
  const nextLink = response?.paging?.nextLink ?? response?.nextLink ?? null;
  if (typeof nextLink === "string") {
    validateNextLink(nextLink, scope);
  }
  const nativePromStatus = normalizeCase(response.status);
  if (nativePromStatus === "success") {
    const data = sanitizeValue(response.data ?? null);
    return {
      status: detectOutcomeStatus(data, "ok"),
      data,
      observationTime: response.observationTime ?? null,
      error: null,
    };
  }
  if (nativePromStatus === "error") {
    const data = sanitizeValue(response.data ?? null);
    return {
      status: "error",
      data,
      observationTime: response.observationTime ?? null,
      error: {
        kind: "capture",
        code: isNonEmptyString(response.errorType) ? response.errorType : "prom_error",
        message: isNonEmptyString(response.error) ? response.error : "Prometheus API returned error status.",
      },
    };
  }
  const data = sanitizeValue(response.data ?? response);
  const status = normalizeEnvelopeStatus(response.status ?? detectOutcomeStatus(data), data);
  return {
    status,
    data,
    observationTime: response.observationTime ?? null,
    error: response.error ? normalizeReceiptError(response.error) : null,
  };
}

function buildAttemptPayload({ suiteId, caseId, validationId, mode, actor, operation, scope, request, startedAt, attemptId }) {
  return buildReceipt({
    suiteId,
    caseId,
    validationId,
    mode,
    actor,
    operation,
    scope,
    request,
    status: "partial",
    response: { phase: "attempted" },
    error: null,
    sourceCapture: null,
    observationTime: null,
    startedAt,
    completedAt: startedAt,
    attemptId,
  });
}

export function createObservationTool(
  { mode, scope, captureSet, evidenceRoot, validationId, caseId, actor = "agent", signal } = {},
  deps = {}
) {
  if (mode !== "recorded" && mode !== "live-readonly") {
    throw new Error("mode must be recorded or live-readonly.");
  }
  guardScope(scope);
  if (!isNonEmptyString(evidenceRoot) || !isNonEmptyString(caseId)) {
    throw new Error("evidenceRoot and caseId are required.");
  }
  if (!captureSet || !Array.isArray(captureSet.entries)) {
    throw new Error("captureSet with validated entries is required.");
  }
  const suiteId = captureSet?.manifest?.id ? "always-on-five-v1" : (captureSet?.suiteId ?? "always-on-five-v1");
  const resolveRecorded = deps.resolveRecorded ?? ((args) => defaultResolveRecorded({ ...args, caseId }));
  const liveTransport =
    deps.liveTransport ??
    ((args) =>
      invokeLiveOperation(args, {
        ...deps,
        captureSet,
        caseId,
      }));

  return {
    name: "azure-readonly-observe",
    description:
      "Read-only observation bridge. Accepts a fixed semantic operation plus parameters and records evidence receipts.",
    parameters: operationSchema(),
    handler: async (input) => {
      const startedAt = nowIso();
      const operation = isObject(input) && isNonEmptyString(input.operation) ? input.operation : "unknown";
      const requestPayload = isObject(input)
        ? { operation: input.operation, parameters: input.parameters ?? {} }
        : { operation: "unknown", parameters: {} };
      const attemptId = randomUUID();
      const attemptPayload = buildAttemptPayload({
        suiteId,
        caseId,
        validationId: validationId ?? null,
        mode,
        actor,
        operation,
        scope,
        request: requestPayload,
        startedAt,
        attemptId,
      });
      await persistReceipt({ evidenceRoot, caseId, operation, payload: attemptPayload });
      try {
        const spec = assertClosedOperationInput(input);
        spec.validate(input.parameters, scope);
      } catch (error) {
        const denial = mapRuntimeError(error);
        const attemptedReceipt = buildReceipt({
          suiteId,
          caseId,
          validationId: validationId ?? null,
          mode,
          actor,
          operation,
          scope,
          request: requestPayload,
          startedAt,
          completedAt: nowIso(),
          observationTime: null,
          status: "denied",
          response: null,
          error: denial,
          sourceCapture: null,
          attemptId,
        });
        const receipt = await persistReceipt({ evidenceRoot, caseId, operation, payload: attemptedReceipt });
        return { status: "denied", mode, operation, data: null, receipt, error: denial };
      }

      let envelope;
      try {
        if (mode === "recorded") {
          const recorded = await resolveRecorded({ request: requestPayload, captureSet, scope, signal });
          envelope = {
            status: normalizeEnvelopeStatus(recorded.status, recorded.data),
            mode,
            operation,
            data: sanitizeValue(recorded.data),
            error: normalizeReceiptError(recorded.error),
            sourceCapture: recorded.sourceCapture ?? null,
            observationTime: recorded.observationTime ?? null,
          };
        } else {
          let response;
          try {
            response = await liveTransport({ request: requestPayload, scope, signal });
            if (!response?.status && mode === "live-readonly") {
              response = { ...response, status: "ok" };
            }
          } catch (error) {
            const mapped = mapLiveInvokeError(error);
            envelope = {
              status: mapped.status,
              mode,
              operation,
              data: null,
              error: mapped.error,
              sourceCapture: null,
              observationTime: null,
            };
          }
          if (!envelope) {
            const projected = projectLiveResponse(response, scope);
            envelope = {
              status: projected.status,
              mode,
              operation,
              data: projected.data,
              error: projected.error,
              sourceCapture: null,
              observationTime: projected.observationTime,
            };
          }
        }
      } catch (error) {
        const mapped = mapRuntimeError(error);
        envelope = {
          status: mapped.kind === "policy" ? "denied" : "error",
          mode,
          operation,
          data: null,
          error: mapped,
          sourceCapture: null,
          observationTime: null,
        };
      }

      const completedAt = nowIso();
      const receiptPayload = buildReceipt({
        suiteId,
        caseId,
        validationId: validationId ?? null,
        mode,
        actor,
        operation,
        scope,
        request: requestPayload,
        startedAt,
        completedAt,
        observationTime: envelope.observationTime,
        status: envelope.status,
        response: envelope.data,
        error: envelope.error,
        sourceCapture: envelope.sourceCapture,
        attemptId,
      });
      const receipt = await persistReceipt({
        evidenceRoot,
        caseId,
        operation,
        payload: receiptPayload,
      });
      return {
        status: envelope.status,
        mode,
        operation,
        data: envelope.data,
        receipt,
        error: envelope.error,
      };
    },
  };
}

async function resolvePackageRoot(workspaceRoot, packagePath) {
  const normalized = packagePath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (
    !isNonEmptyString(normalized) ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw policyError("package_path_shape", "packagePath must stay inside workspace root.");
  }
  const rootReal = await realpath(workspaceRoot);
  const packageAbsolute = path.resolve(rootReal, normalized);
  const packageStats = await lstat(packageAbsolute);
  if (packageStats.isSymbolicLink()) {
    throw policyError("package_symlink", "package root cannot be a symlink.");
  }
  const packageReal = await realpath(packageAbsolute);
  const relative = path.relative(rootReal, packageReal);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw policyError("package_escape", "packagePath escapes workspace root.");
  }
  return { rootReal, packageReal, packagePath: normalized };
}

async function collectPackageFiles(packageRoot) {
  const files = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        throw policyError("package_symlink", `package file '${absolute}' must not be a symlink.`);
      }
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const content = await readFile(absolute, "utf8");
      files.push({
        path: path.relative(packageRoot, absolute).replaceAll("\\", "/"),
        sha256: sha256(content),
      });
    }
  }
  await walk(packageRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function inspectPackage({ workspaceRoot, packagePath }) {
  const { packageReal, packagePath: normalizedPath } = await resolvePackageRoot(workspaceRoot, packagePath);
  const packageBytes = await readFile(path.join(packageReal, "package.json"), "utf8");
  const parametersBytes = await readFile(path.join(packageReal, "parameters.json"), "utf8");
  const packageJson = JSON.parse(packageBytes);
  const targets = Array.isArray(packageJson?.targets) ? packageJson.targets.map(String) : [];
  const operations = Array.isArray(packageJson?.operations) ? packageJson.operations.map(String) : [];
  const files = await collectPackageFiles(packageReal);
  const aggregateHash = sha256(files.map((entry) => `${entry.path}:${entry.sha256}`).join("\n"));
  return {
    packagePath: normalizedPath,
    contentSha256: aggregateHash,
    parametersSha256: sha256(parametersBytes),
    targets,
    operations,
    files,
  };
}

function resolveApprovalOracle(captureSet, caseId) {
  const APPROVAL_ORACLE_PATHS = ["files/private/darkux-approval-oracle.json", "host/approval-oracle.json"];
  const entries = getCaptureEntries(captureSet, caseId);
  const oracleEntry = entries.find(
    (entry) => entry.kind === "schema" && entry.visibility === "host" && APPROVAL_ORACLE_PATHS.includes(entry.path)
  );
  if (!oracleEntry) {
    throw captureError("oracle_missing", "No private rehearsal approval oracle entry was found.");
  }
  const payload = parseCaptureEntry(oracleEntry);
  if (!payload || !isNonEmptyString(payload.approvedPackagePath) || !isNonEmptyString(payload.reviewRecord)) {
    throw captureError("oracle_invalid", "Approval oracle payload is invalid.");
  }
  const reviewEntry = entries.find((entry) => entry.path === payload.reviewRecord);
  if (!reviewEntry) {
    throw captureError("oracle_invalid", "Approval review record entry was not found in capture set.");
  }
  const reviewPayload = parseCaptureEntry(reviewEntry);
  if (
    !isObject(reviewPayload) ||
    !Array.isArray(reviewPayload.approvedOperations) ||
    !Array.isArray(reviewPayload.approvedTargets)
  ) {
    throw captureError("oracle_invalid", "Approval review record payload is invalid.");
  }
  const approvedOperations = reviewPayload.approvedOperations.filter(isNonEmptyString).map((value) => value.trim());
  const approvedTargets = reviewPayload.approvedTargets.filter(isNonEmptyString).map((value) => value.trim());
  if (approvedOperations.length === 0 || approvedTargets.length === 0) {
    throw captureError("oracle_invalid", "Approval review record does not include approved operations and targets.");
  }
  const approvedPackagePath = payload.approvedPackagePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const packagePrefix = `${approvedPackagePath}/`;
  const approvedPackageEntries = entries
    .filter((entry) => entry.kind === "package" && entry.path.startsWith(packagePrefix))
    .map((entry) => ({
      path: entry.path,
      relativePath: entry.path.slice(packagePrefix.length),
      sha256: String(entry.sha256 ?? "").trim().toLowerCase(),
    }))
    .filter((entry) => isNonEmptyString(entry.relativePath));
  const explicitContentSha256 = isNonEmptyString(payload.approvedContentSha256)
    ? payload.approvedContentSha256.trim().toLowerCase()
    : null;
  if (explicitContentSha256 && !/^[a-f0-9]{64}$/.test(explicitContentSha256)) {
    throw captureError("oracle_invalid", "approvedContentSha256 in approval oracle is required and must be a SHA-256 digest.");
  }
  let derivedContentSha256 = null;
  if (approvedPackageEntries.length > 0) {
    for (const entry of approvedPackageEntries) {
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw captureError("oracle_invalid", "Approved package material contains an invalid SHA-256 digest.");
      }
    }
    approvedPackageEntries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    derivedContentSha256 = sha256(approvedPackageEntries.map((entry) => `${entry.relativePath}:${entry.sha256}`).join("\n"));
  }
  if (!explicitContentSha256 && approvedPackageEntries.length === 0) {
    throw captureError("oracle_invalid", "Approved package material is missing from the locked capture set.");
  }
  if (!explicitContentSha256 && !derivedContentSha256) {
    throw captureError("oracle_invalid", "No approved package digest was provided or derivable from locked package material.");
  }
  if (explicitContentSha256 && derivedContentSha256 && explicitContentSha256 !== derivedContentSha256) {
    throw captureError("oracle_invalid", "approvedContentSha256 does not match the locked approved package material digest.");
  }
  const approvedContentSha256 = explicitContentSha256 ?? derivedContentSha256;
  const digestProvenance =
    explicitContentSha256 != null
      ? { mode: "explicit", sourcePath: oracleEntry.path }
      : {
          mode: "derived-locked-package-material",
          packagePath: approvedPackagePath,
          materialRefs: approvedPackageEntries.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
        };
  return {
    approvedPackagePath,
    approvedContentSha256,
    approvedOperations,
    approvedTargets,
    reviewRecord: payload.reviewRecord,
    digestProvenance,
    sourceCapture: { path: oracleEntry.path, sha256: oracleEntry.sha256 },
  };
}

function asNormalizedSet(values) {
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()))].sort();
}

function sameStringSet(left, right) {
  const a = asNormalizedSet(left);
  const b = asNormalizedSet(right);
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function captureHasOperationAndTarget(payload, operation, targets) {
  const operationFromPayload = String(
    payload?.operation ?? payload?.request?.operation ?? payload?.request?.name ?? payload?.meta?.operation ?? ""
  )
    .trim()
    .toLowerCase();
  if (!operationFromPayload || operationFromPayload !== operation.toLowerCase()) {
    return false;
  }
  const targetCandidates = [
    payload?.target,
    payload?.entityId,
    payload?.resourceId,
    payload?.request?.target,
    payload?.request?.entityId,
    payload?.request?.resourceId,
  ]
    .filter(isNonEmptyString)
    .map((value) => String(value).trim().toLowerCase());
  if (targetCandidates.length === 0) {
    return false;
  }
  const requested = new Set(targets.map((value) => String(value).trim().toLowerCase()));
  return targetCandidates.some((value) => requested.has(value));
}

function collectRecordedReadbacks(captureSet, caseId, operation, targets) {
  const entries = getCaptureEntries(captureSet, caseId).filter((entry) => entry.kind === "capture" && entry.visibility === "agent");
  const readbacks = [];
  for (const entry of entries) {
    const payload = parseCaptureEntry(entry);
    if (!payload) continue;
    if (!captureHasOperationAndTarget(payload, operation, targets)) continue;
    readbacks.push({
      path: entry.path,
      sha256: entry.sha256,
      payload: sanitizeValue(payload),
    });
  }
  return readbacks;
}

function findCaptureEntryByRef(captureSet, caseId, refPath, refSha256) {
  const normalizedPath = String(refPath ?? "").trim().replaceAll("\\", "/");
  const normalizedSha = String(refSha256 ?? "").trim().toLowerCase();
  if (!isNonEmptyString(normalizedPath) || !/^[a-f0-9]{64}$/.test(normalizedSha)) {
    return null;
  }
  const entries = getCaptureEntries(captureSet, caseId);
  return (
    entries.find(
      (entry) =>
        entry.kind === "capture" &&
        entry.visibility === "agent" &&
        entry.path === normalizedPath &&
        String(entry.sha256 ?? "").toLowerCase() === normalizedSha
    ) ?? null
  );
}

function resolveRecordedSourcePlan({ captureSet, caseId, approvedPackagePath }) {
  const entries = getCaptureEntries(captureSet, caseId);
  const materialPath = `${approvedPackagePath}/material-recorded-ops.json`;
  const materialEntry = entries.find((entry) => entry.path === materialPath && entry.kind === "package");
  if (!materialEntry) return null;
  const materialPayload = parseCaptureEntry(materialEntry);
  if (!isObject(materialPayload)) {
    throw captureError("capture_invalid", "Approved package material-recorded-ops.json is not valid JSON.");
  }
  const generatedFrom = materialPayload.generatedFrom;
  if (!isObject(generatedFrom)) {
    throw captureError("capture_invalid", "Approved package material is missing generatedFrom capture provenance.");
  }
  const deploymentRef = {
    path: generatedFrom.deploymentOperationsPath,
    sha256: generatedFrom.deploymentOperationsSha256,
  };
  const readbackRef = {
    path: generatedFrom.modelReadbackPath,
    sha256: generatedFrom.modelReadbackSha256,
  };
  const deploymentEntry = findCaptureEntryByRef(captureSet, caseId, deploymentRef.path, deploymentRef.sha256);
  const readbackEntry = findCaptureEntryByRef(captureSet, caseId, readbackRef.path, readbackRef.sha256);
  if (!deploymentEntry || !readbackEntry) {
    throw captureError("capture_invalid", "Approved package material capture references are missing from the locked capture set.");
  }
  return {
    mode: "locked-material-generatedFrom",
    materialPath,
    limits: sanitizeValue(materialPayload.limits ?? null),
    historicalEvidenceOnly: Boolean(materialPayload.historicalEvidenceOnly),
    refs: {
      deploymentOperations: { path: deploymentEntry.path, sha256: deploymentEntry.sha256 },
      modelReadback: { path: readbackEntry.path, sha256: readbackEntry.sha256 },
    },
  };
}

function normalizeReadbackPayloadFromPlan({ sourcePlan, captureSet, caseId, operation, targets }) {
  const requestedTargets = new Set(targets.map((value) => String(value).trim().toLowerCase()));
  if (operation === "deployment.operation.group.list") {
    const entry = findCaptureEntryByRef(
      captureSet,
      caseId,
      sourcePlan.refs.deploymentOperations.path,
      sourcePlan.refs.deploymentOperations.sha256
    );
    const payload = entry ? parseCaptureEntry(entry) : null;
    if (!entry || !payload || !Array.isArray(payload.result)) {
      return { status: "error", error: { kind: "capture", code: "capture_invalid", message: "Deployment operations capture shape is invalid." } };
    }
    const rows = payload.result;
    if (rows.length === 0) {
      return {
        status: "empty",
        readbacks: [
          {
            path: entry.path,
            sha256: entry.sha256,
            payload: sanitizeValue({
              source: "historical-create-operations",
              historicalEvidenceOnly: sourcePlan.historicalEvidenceOnly,
              limits: sourcePlan.limits,
              result: [],
            }),
          },
        ],
      };
    }
    const matched = rows.filter((row) => {
      const op = String(row?.operation ?? "").trim().toLowerCase();
      const target = String(row?.targetId ?? row?.id ?? "").trim().toLowerCase();
      return op === "create" && requestedTargets.has(target);
    });
    if (matched.length === 0) {
      return {
        status: "error",
        error: { kind: "capture", code: "capture_missing", message: "No historical create operations matched approved targets." },
      };
    }
    return {
      status: "ok",
      readbacks: [
        {
          path: entry.path,
          sha256: entry.sha256,
          payload: sanitizeValue({
            source: "historical-create-operations",
            historicalEvidenceOnly: sourcePlan.historicalEvidenceOnly,
            limits: sourcePlan.limits,
            result: matched,
          }),
        },
      ],
    };
  }
  if (operation === "model.readback.get") {
    const entry = findCaptureEntryByRef(captureSet, caseId, sourcePlan.refs.modelReadback.path, sourcePlan.refs.modelReadback.sha256);
    const payload = entry ? parseCaptureEntry(entry) : null;
    if (!entry || !payload || !isObject(payload.result)) {
      return { status: "error", error: { kind: "capture", code: "capture_invalid", message: "Model readback capture shape is invalid." } };
    }
    const readbackId = String(payload.result.id ?? "").trim().toLowerCase();
    if (!readbackId) {
      return {
        status: "error",
        error: { kind: "capture", code: "capture_missing", message: "Model readback capture did not include a target id." },
      };
    }
    if (!requestedTargets.has(readbackId)) {
      return {
        status: "error",
        error: { kind: "capture", code: "capture_missing", message: "Model readback capture target did not match approved targets." },
      };
    }
    return {
      status: "ok",
      readbacks: [
        {
          path: entry.path,
          sha256: entry.sha256,
          payload: sanitizeValue({
            source: "historical-model-readback",
            historicalEvidenceOnly: sourcePlan.historicalEvidenceOnly,
            limits: sourcePlan.limits,
            result: payload.result,
          }),
        },
      ],
    };
  }
  return null;
}

async function resolveRehearsalExecution({ captureSet, caseId, inspected, operation, claimedTargets }) {
  const oracle = resolveApprovalOracle(captureSet, caseId);
  const normalizedPackage = inspected.packagePath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalizedPackage !== oracle.approvedPackagePath) {
    return {
      status: "denied",
      data: {
        packagePath: inspected.packagePath,
        operation,
        claimedTargets,
        inspected,
      },
      error: { kind: "policy", code: "approval_denied", message: "Changed package requires renewed review approval." },
      sourceCapture: oracle.sourceCapture,
      observationTime: null,
    };
  }
  if (inspected.contentSha256 !== oracle.approvedContentSha256) {
    return {
      status: "denied",
      data: {
        packagePath: inspected.packagePath,
        operation,
        claimedTargets,
        inspected,
      },
      error: { kind: "policy", code: "package_hash_mismatch", message: "Package content hash differs from approved review." },
      sourceCapture: oracle.sourceCapture,
      observationTime: null,
    };
  }
  if (!sameStringSet(inspected.operations, oracle.approvedOperations)) {
    return {
      status: "denied",
      data: {
        packagePath: inspected.packagePath,
        operation,
        claimedTargets,
        inspected,
      },
      error: { kind: "policy", code: "operation_set_not_approved", message: "Inspected operation set does not match benchmark review approval." },
      sourceCapture: oracle.sourceCapture,
      observationTime: null,
    };
  }
  if (!sameStringSet(inspected.targets, oracle.approvedTargets)) {
    return {
      status: "denied",
      data: {
        packagePath: inspected.packagePath,
        operation,
        claimedTargets,
        inspected,
      },
      error: { kind: "policy", code: "target_set_not_approved", message: "Inspected target set does not match benchmark review approval." },
      sourceCapture: oracle.sourceCapture,
      observationTime: null,
    };
  }
  if (!oracle.approvedOperations.includes(operation)) {
    return {
      status: "denied",
      data: {
        packagePath: inspected.packagePath,
        operation,
        claimedTargets,
        inspected,
      },
      error: { kind: "policy", code: "operation_not_approved", message: "Operation is not approved by benchmark review record." },
      sourceCapture: oracle.sourceCapture,
      observationTime: null,
    };
  }
  const unknownTargets = claimedTargets.filter((target) => !oracle.approvedTargets.includes(target));
  if (unknownTargets.length > 0) {
    return {
      status: "denied",
      data: {
        packagePath: inspected.packagePath,
        operation,
        claimedTargets,
        inspected,
      },
      error: { kind: "policy", code: "target_not_approved", message: "Claimed target is not approved by benchmark review record." },
      sourceCapture: oracle.sourceCapture,
      observationTime: null,
    };
  }
  if (!sameStringSet(claimedTargets, inspected.targets)) {
    return {
      status: "denied",
      data: {
        packagePath: inspected.packagePath,
        operation,
        claimedTargets,
        inspected,
      },
      error: { kind: "policy", code: "claimed_targets_mismatch", message: "claimedTargets must exactly match inspected package targets." },
      sourceCapture: oracle.sourceCapture,
      observationTime: null,
    };
  }
  const sourcePlan = resolveRecordedSourcePlan({
    captureSet,
    caseId,
    approvedPackagePath: oracle.approvedPackagePath,
  });
  let readbacks = [];
  if (sourcePlan) {
    const normalized = normalizeReadbackPayloadFromPlan({
      sourcePlan,
      captureSet,
      caseId,
      operation,
      targets: claimedTargets,
    });
    if (normalized?.status === "error") {
      return {
        status: "error",
        data: {
          packagePath: inspected.packagePath,
          operation,
          claimedTargets,
          inspected,
          reviewedRecord: oracle.reviewRecord,
          approvalDigestProvenance: oracle.digestProvenance,
          sourcePlan,
        },
        error: normalized.error,
        sourceCapture: oracle.sourceCapture,
        observationTime: null,
      };
    }
    if (normalized?.readbacks) {
      readbacks = normalized.readbacks;
      if (normalized.status === "empty") {
        return {
          status: "empty",
          data: {
            packagePath: inspected.packagePath,
            operation,
            claimedTargets,
            reviewedRecord: oracle.reviewRecord,
            approvalDigestProvenance: oracle.digestProvenance,
            matchedCaptureRefs: readbacks.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
            readbacks,
            sourcePlan,
          },
          error: null,
          sourceCapture: readbacks[0] ? { path: readbacks[0].path, sha256: readbacks[0].sha256 } : oracle.sourceCapture,
          observationTime: null,
        };
      }
    }
  } else {
    readbacks = collectRecordedReadbacks(captureSet, caseId, operation, claimedTargets);
  }
  return {
    status: readbacks.length > 0 ? "ok" : "empty",
    data: {
      packagePath: inspected.packagePath,
      operation,
      claimedTargets,
      reviewedRecord: oracle.reviewRecord,
      approvalDigestProvenance: oracle.digestProvenance,
      sourcePlan,
      matchedCaptureRefs: readbacks.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
      readbacks,
    },
    error: null,
    sourceCapture: readbacks[0] ? { path: readbacks[0].path, sha256: readbacks[0].sha256 } : oracle.sourceCapture,
    observationTime: null,
  };
}

export function createRehearsalTool(
  { captureSet, workspaceRoot, evidenceRoot, caseId, validationId, signal } = {},
  deps = {}
) {
  if (!isNonEmptyString(workspaceRoot) || !isNonEmptyString(evidenceRoot) || !isNonEmptyString(caseId)) {
    throw new Error("workspaceRoot, evidenceRoot, and caseId are required.");
  }
  if (!captureSet || !Array.isArray(captureSet.entries)) {
    throw new Error("captureSet with validated entries is required.");
  }
  const suiteId = captureSet?.suiteId ?? "always-on-five-v1";
  const inspectFn = deps.inspectPackage ?? inspectPackage;
  const executeRecorded = deps.executeRecorded ?? ((args) => resolveRehearsalExecution(args));

  return {
    name: "azure-readonly-rehearsal",
    description:
      "Recorded-only rehearsal executor for change packages. Supports inspect and execute with approval checks.",
    parameters: rehearsalSchema(),
    handler: async (input) => {
      const startedAt = nowIso();
      const attemptId = randomUUID();
      let operation = "rehearsal.unknown";
      try {
        if (!isObject(input) || !isNonEmptyString(input.action) || !isNonEmptyString(input.packagePath)) {
          throw policyError("rehearsal_input", "Invalid rehearsal input.");
        }
        if (input.action !== "inspect" && input.action !== "execute") {
          throw policyError("rehearsal_action", `Unsupported rehearsal action '${input.action}'.`);
        }
        operation = input.action === "inspect" ? "rehearsal.inspect" : "rehearsal.execute";
      } catch (error) {
        const mapped = mapRuntimeError(error);
        const payload = buildReceipt({
          suiteId,
          caseId,
          validationId: validationId ?? null,
          mode: "rehearsal",
          actor: "agent",
          operation,
          scope: ALLOWED_SCOPE,
          request: isObject(input) ? input : {},
          startedAt,
          completedAt: nowIso(),
          observationTime: null,
          status: "denied",
          response: null,
          error: mapped,
          sourceCapture: null,
          attemptId,
        });
        const receipt = await persistReceipt({ evidenceRoot, caseId, operation, payload });
        return { status: "denied", mode: "rehearsal", operation, data: null, receipt, error: mapped };
      }

      if (operation === "rehearsal.execute") {
        const attemptPayload = buildAttemptPayload({
          suiteId,
          caseId,
          validationId: validationId ?? null,
          mode: "rehearsal",
          actor: "agent",
          operation,
          scope: ALLOWED_SCOPE,
          request: input,
          startedAt,
          attemptId,
        });
        await persistReceipt({ evidenceRoot, caseId, operation, payload: attemptPayload });
      }

      let envelope;
      try {
        if (operation === "rehearsal.inspect") {
          const inspected = await inspectFn({ workspaceRoot, packagePath: input.packagePath, signal });
          envelope = {
            status: "ok",
            mode: "rehearsal",
            operation,
            data: inspected,
            error: null,
            sourceCapture: null,
            observationTime: null,
          };
        } else {
          if (!isNonEmptyString(input.operation) || !Array.isArray(input.claimedTargets) || input.claimedTargets.length === 0) {
            throw policyError("execute_shape", "execute requires operation and non-empty claimedTargets.");
          }
          const inspected = await inspectFn({ workspaceRoot, packagePath: input.packagePath, signal });
          const executed = await executeRecorded({
            captureSet,
            caseId,
            inspected,
            operation: input.operation,
            claimedTargets: input.claimedTargets,
            signal,
          });
          envelope = {
            status: normalizeEnvelopeStatus(executed.status, executed.data),
            mode: "rehearsal",
            operation,
            data: sanitizeValue(executed.data ?? null),
            error: normalizeReceiptError(executed.error),
            sourceCapture: executed.sourceCapture ?? null,
            observationTime: executed.observationTime ?? null,
          };
        }
      } catch (error) {
        const mapped = mapRuntimeError(error);
        envelope = {
          status: mapped.kind === "policy" ? "denied" : "error",
          mode: "rehearsal",
          operation,
          data: null,
          error: mapped,
          sourceCapture: null,
          observationTime: null,
        };
      }

      const receiptPayload = buildReceipt({
        suiteId,
        caseId,
        validationId: validationId ?? null,
        mode: "rehearsal",
        actor: "agent",
        operation,
        scope: ALLOWED_SCOPE,
        request: input,
        startedAt,
        completedAt: nowIso(),
        observationTime: envelope.observationTime,
        status: envelope.status,
        response: envelope.data,
        error: envelope.error,
        sourceCapture: envelope.sourceCapture,
        attemptId,
      });
      const receipt = await persistReceipt({ evidenceRoot, caseId, operation, payload: receiptPayload });
      return {
        status: envelope.status,
        mode: "rehearsal",
        operation,
        data: envelope.data,
        receipt,
        error: envelope.error,
      };
    },
  };
}
