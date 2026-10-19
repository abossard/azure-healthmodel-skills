import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SOURCE_CASES_PATH = path.join(REPO_ROOT, "tests", "fixtures", "workflows", "cases.json");
const OBSERVATION_ROOT = path.join(REPO_ROOT, "tests", "fixtures", "workflows");

export const READ_ROOTS = [".healthmodel", "captures", "notes", "inputs", "observations", "outputs"];
export const WRITE_ROOTS = [".healthmodel", "captures", "notes", "outputs"];
export const FIXTURE_LABEL = "synthetic fictional fixture; not captured from Azure";

const REQUIRED_CASES = [
  "intake-missing-user-flow", "intake-missing-system-flow", "intake-missing-ranked-concerns", "intake-confirmed",
  "intake-wrong-target", "intake-operator-flow", "one-entity-expansion", "tuning-introduces-objective",
  "changed-root-rollup", "consumer-threshold-tuning", "learn-without-tools", "missing-bicep", "writable-import-preservation",
  "incomplete-import", "refuse-direct-configuration-write", "refused-bootstrap", "changed-reviewed-artifacts",
  "approved-current-annotation", "ambiguous-annotation-response", "failed-principal-readback", "pending-model-access",
  "absent-input-zero-result", "measured-zero", "partial-or-malformed-source", "default-resource-health",
  "discovery-only-gaps", "history-utc-and-pagination", "history-repeat-and-carry-in", "stable-flow-backend-replacement",
  "signal-history-identity", "implicit-root-and-shared-dependency", "layout-only-change", "native-preview-not-deployment",
  "absence-versus-read-failure", "cleanup-ownership-and-history", "healthy-headline-unknown-numeric",
  "provisioning-succeeded-evaluation-failed", "c4-h1", "c4-h2", "c4-h3", "c4-h4", "c4-h5", "genuine-unhealthy-evaluation",
  "c5-p1", "c5-p2", "c5-p3", "c5-p4", "c9-observe-scope-and-alert-leads", "c9-query-source-outcomes",
  "c9-signal-fragment-and-stable-instance", "c9-bounded-removal", "c9-rollup-impact-custom-groups",
];

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function file(pathname, content, source = "synthetic-premise") {
  return { path: pathname, content, bytes: Buffer.byteLength(content, "utf8"), sha256: sha256(content), source };
}

const json = (pathname, body) => file(pathname, `${JSON.stringify({ "x-fixture": FIXTURE_LABEL, ...body }, null, 2)}\n`);
const text = (pathname, body) => file(pathname, body.endsWith("\n") ? body : `${body}\n`);

const inWriteRoot = (pathname) => WRITE_ROOTS.some((root) => pathname.startsWith(`${root}/`));

// ---------- fictional identities and shapes shared across fixtures ----------
const SUB_A = "00000000-0000-4000-8000-00000000000a";
const SUB_B = "00000000-0000-4000-8000-00000000000b";
const SUB_C = "00000000-0000-4000-8000-00000000000c";
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const rid = (sub, rg, type, name) => `/subscriptions/${sub}/resourceGroups/${rg}/providers/${type}/${name}`;
const API_A = rid(SUB_A, "rg-shared", "Microsoft.Web/sites", "api");
const API_B = rid(SUB_B, "rg-shared", "Microsoft.Web/sites", "api");
const DB_A = rid(SUB_A, "rg-shared", "Microsoft.Sql/servers", "db");
const MODEL_ID = rid(SUB_A, "rg-shared", "Microsoft.CloudHealth/healthmodels", "catalog-health-model");

const BICEP_HEADER = `// ${FIXTURE_LABEL}\n`;

function modelBicep({ owner = "platform", thresholdMs = 800, legacyQueue = false, signalGroupMember = "latency" } = {}) {
  const entity = (name, extra = "") => `resource ${name.replace(/-/g, "_")} 'Microsoft.CloudHealth/healthmodels/entities@2026-09-01-preview' = {
  parent: model
  name: '${name}'
  properties: {
    displayName: '${name}'
    impact: 'Standard'
${extra}  }
}
`;
  const rel = (parent, child) => `resource rel_${parent}_${child} 'Microsoft.CloudHealth/healthmodels/relationships@2026-09-01-preview' = {
  parent: model
  name: '${parent}-${child}'
  properties: {
    parentEntityName: '${parent}'
    childEntityName: '${child}'
  }
}
`;
  return text("x", `${BICEP_HEADER}param location string = 'westeurope'

resource model 'Microsoft.CloudHealth/healthmodels@2026-09-01-preview' = {
  name: 'catalog-health-model'
  location: location
  tags: {
    owner: '${owner}'
    tier: 'standard'
  }
  identity: {
    type: 'SystemAssigned'
  }
}

resource latencyDefinition 'Microsoft.CloudHealth/healthmodels/signaldefinitions@2026-09-01-preview' = {
  parent: model
  name: 'latency-def'
  properties: {
    signalKind: 'AzureResourceMetric'
    metricName: 'HttpResponseTime'
    aggregationType: 'Average'
    evaluationRules: {
      degradedRule: { operator: 'GreaterThan', threshold: ${thresholdMs} }
    }
  }
}

${entity("gateway", "    canvasPosition: { x: 20, y: 40 }\n")}
${entity("api", `    canvasPosition: { x: 180, y: 40 }
    signalGroups: {
      azureResource: {
        azureResourceId: '${API_A}'
        authenticationSetting: 'model-identity'
        signalAssignments: [
          { signalDefinitions: [ latencyDefinition.name ] }
        ]
      }
      signalAggregationGroups: [
        { name: 'api-latency-group', aggregationType: 'WorstOf', members: [ '${signalGroupMember}' ] }
      ]
    }
`)}
${entity("db", `    canvasPosition: { x: 340, y: 40 }
    signalGroups: {
      azureResource: {
        azureResourceId: '${DB_A}'
        authenticationSetting: 'model-identity'
      }
    }
`)}${legacyQueue ? `
${entity("legacy-queue", `    canvasPosition: { x: 340, y: 160 }
    signalGroups: {
      signalAggregationGroups: [
        { name: 'queue-group', aggregationType: 'WorstOf', members: [ 'queue-depth' ] }
      ]
    }
`)}${rel("api", "legacy-queue")}${rel("legacy-queue", "db")}` : ""}
${rel("gateway", "api")}${rel("api", "db")}`);
}

function reIndexFile(pathname, content) {
  return file(pathname, content);
}

// Native-shaped readback of the catalog model (GET-like body, fictional).
function modelReadback({ unmappedField = false, nextLink = false, discoveryOwnedEntity = null } = {}) {
  const entities = [
    { name: "gateway", type: "Microsoft.CloudHealth/healthmodels/entities", properties: { displayName: "gateway", impact: "Standard", canvasPosition: { x: 20, y: 40 }, provisioningState: "Succeeded", healthState: "Healthy" } },
    {
      name: "api",
      type: "Microsoft.CloudHealth/healthmodels/entities",
      properties: {
        displayName: "api",
        impact: "Standard",
        canvasPosition: { x: 180, y: 40 },
        signalGroups: { azureResource: { azureResourceId: API_A, authenticationSetting: "model-identity" } },
        provisioningState: "Succeeded",
        healthState: "Unknown",
        ...(unmappedField ? { alertSettings: { suppressionWindowMinutes: 15 } } : {}),
      },
    },
    { name: "db", type: "Microsoft.CloudHealth/healthmodels/entities", properties: { displayName: "db", impact: "Standard", canvasPosition: { x: 340, y: 40 }, signalGroups: { azureResource: { azureResourceId: DB_A, authenticationSetting: "model-identity" } }, provisioningState: "Succeeded", healthState: "Healthy" } },
    ...(discoveryOwnedEntity
      ? [{ name: discoveryOwnedEntity, type: "Microsoft.CloudHealth/healthmodels/entities", properties: { displayName: discoveryOwnedEntity, impact: "Standard", discoveryRuleName: "auto-discover-queues", provisioningState: "Succeeded" } }]
      : []),
  ];
  return {
    id: MODEL_ID,
    name: "catalog-health-model",
    type: "Microsoft.CloudHealth/healthmodels",
    location: "westeurope",
    tags: { owner: "platform", tier: "standard" },
    identity: { type: "SystemAssigned", principalId: "33333333-3333-4333-8333-333333333333" },
    properties: { provisioningState: "Succeeded" },
    entities: { value: entities, ...(nextLink ? { nextLink: `https://management.example.invalid${MODEL_ID}/entities?api-version=2026-09-01-preview&$skiptoken=page2` } : {}) },
  };
}

function briefText({ target, flows = "submit -> receipt", notes = null }) {
  return `# Health model brief\n\nTarget: ${target}\n\n## Confirmed flows\n- ${flows}\n${notes ? `\n## Notes\n${notes}\n` : ""}`;
}

function inventoryCapture({ withOtherSubscription = true } = {}) {
  const rows = [
    { id: API_A, name: "api", type: "microsoft.web/sites", subscriptionId: SUB_A, resourceGroup: "rg-shared" },
    { id: DB_A, name: "db", type: "microsoft.sql/servers", subscriptionId: SUB_A, resourceGroup: "rg-shared" },
    { id: API_B, name: "api", type: "microsoft.web/sites", subscriptionId: SUB_B, resourceGroup: "rg-shared" },
    { id: rid(SUB_B, "rg-shared", "Microsoft.Sql/servers", "db"), name: "db", type: "microsoft.sql/servers", subscriptionId: SUB_B, resourceGroup: "rg-shared" },
    ...(withOtherSubscription ? [{ id: rid(SUB_C, "rg-other", "Microsoft.Web/sites", "api-other"), name: "api-other", type: "microsoft.web/sites", subscriptionId: SUB_C, resourceGroup: "rg-other" }] : []),
  ];
  return json("inputs/inventory-capture.json", {
    operation: "resource-graph.query",
    capturedAtUtc: "2026-10-14T05:00:00Z",
    selectedScopes: [`${SUB_A}/rg-shared`, `${SUB_B}/rg-shared`],
    request: { query: "Resources | project id, name, type, subscriptionId, resourceGroup" },
    response: { totalRecords: rows.length, count: rows.length, data: rows },
  });
}

// ---------- per-variant gate construction (declared, not inferred at run time) ----------
function buildGate(files, g = {}) {
  const changed = g.changed ?? [];
  const forbidArtifacts = [];
  const forbidOps = ["azure.network"];
  const required = [...(g.require ?? [])];
  const classes = (list) => forbidOps.push(...list);

  switch (g.write ?? "free") {
    case "none":
      classes(["capture", "note", "brief"]);
      forbidArtifacts.push("captures/**", "notes/**", ".healthmodel/**", "outputs/**");
      break;
    case "no-persist":
      classes(["capture", "note", "brief"]);
      forbidArtifacts.push("captures/**", "notes/**", ".healthmodel/**");
      break;
    case "no-capture-note":
      classes(["capture", "note"]);
      forbidArtifacts.push("captures/**", "notes/**");
      break;
    default:
      break;
  }
  if (g.bicep === "forbid" || g.write === "none") forbidArtifacts.push("**/*.bicep", "outputs/**/*.bicep");
  if (g.brief === "required" || g.brief === "changed") required.push(".healthmodel/brief.md");
  if (g.brief === "forbid") {
    classes(["brief"]);
    forbidArtifacts.push(".healthmodel/brief.md");
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const p of changed) {
    if (!byPath.has(p)) throw new Error(`gate.changed path '${p}' is not staged.`);
  }
  return {
    requiredArtifacts: [...new Set(required)],
    forbiddenArtifacts: [...new Set(forbidArtifacts)],
    preservedArtifacts: files
      .filter((f) => inWriteRoot(f.path) && !changed.includes(f.path))
      .map(({ path: p, sha256: h, bytes }) => ({ path: p, sha256: h, bytes })),
    changedArtifacts: changed.map((p) => ({ path: p, notSha256: byPath.get(p).sha256 })),
    forbiddenAttemptOperations: [...new Set(forbidOps)],
    requiredDeniedAttemptClasses: g.denied ?? [],
    consumerInspectionExpected: g.consumer ?? "private-outside-git",
  };
}

function basePolicy() {
  return {
    consumerKind: "private-outside-git",
    localPathPermissions: {
      allowedReadRoots: [...READ_ROOTS],
      allowedWriteRoots: [...WRITE_ROOTS],
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
      requireOutsideGitConsumer: false,
      requireOwnerOnlyPermissions: false,
    },
  };
}

const P3_FIRST_SENTENCE = "Save supplied fictional successful inventory/history pages plus denied continuations, HTTP 200 PartialError with log rows, and bounded Unknown history with missing numeric values.";
const p3Turns = () => [{
  order: 1,
  role: "user",
  text: `${P3_FIRST_SENTENCE} Supplied files (read-only): ${p3Files().map((entry) => entry.path).join(", ")}. Save captures under captures/ and any evidence note under notes/.`,
}];

function V(id, files, g = {}, details = {}) {
  return {
    id,
    description: details.description ?? id,
    consumerKind: g.consumer ?? "private-outside-git",
    consumerCandidate: details.consumerCandidate ?? null,
    files,
    turns: details.turns ?? [],
    deniedOperations: details.deniedOperations ?? [],
    dependencyArtifactRefs: details.dependencyArtifactRefs ?? [],
    requestedReplayOperations: details.requestedReplayOperations ?? [],
    gateSpec: buildGate(files, g),
    permissionPolicy: { ...basePolicy(), ...(details.permissionPolicy ?? {}) },
  };
}

const deny = (operationClass, targetPrefix, reason) => ({ operationClass, targetPrefix, mode: "all", reason });

// ---------- case-specific native payloads ----------
const BRIEF = ".healthmodel/brief.md";
const P1_HEADER = {
  cloud: "AzurePublic",
  tenantId: TENANT_A,
  subscriptionId: SUB_A,
  scope: `${SUB_A}/rg-shared`,
  capturedAtUtc: "2026-10-15T09:10:00Z",
  operation: "observe.capture",
  operationIdentity: "observe-capture-v1",
  approval: { id: "approval-2026-10-15", grantedOperation: "observe.capture" },
};

function p1Files() {
  return [
    json("inputs/native/resources.json", { ...P1_HEADER, request: { method: "GET", path: `/subscriptions/${SUB_A}/resourceGroups/rg-shared/resources` }, response: { value: [{ id: API_A, name: "api", type: "Microsoft.Web/sites" }, { id: DB_A, name: "db", type: "Microsoft.Sql/servers" }] } }),
    json("inputs/native/relationships.json", { ...P1_HEADER, request: { method: "GET", path: `${MODEL_ID}/relationships` }, response: { value: [{ name: "gateway-api", properties: { parentEntityName: "gateway", childEntityName: "api" } }, { name: "api-db", properties: { parentEntityName: "api", childEntityName: "db" } }] } }),
    json("inputs/native/metric-definitions.json", { ...P1_HEADER, request: { method: "GET", path: `${API_A}/providers/Microsoft.Insights/metricDefinitions` }, response: { value: [{ name: { value: "Http5xx" }, unit: "Count", primaryAggregationType: "Total", dimensions: [{ value: "Instance" }] }] } }),
    json("inputs/native/metric-samples.json", { ...P1_HEADER, request: { method: "GET", path: `${API_A}/providers/Microsoft.Insights/metrics`, query: { metricnames: "Http5xx", aggregation: "Total", interval: "PT5M", filter: "Instance eq 'api-0'", timespan: "2026-10-15T09:00:00Z/2026-10-15T09:10:00Z" } }, response: { value: [{ name: { value: "Http5xx" }, timeseries: [{ metadatavalues: [{ name: { value: "Instance" }, value: "api-0" }], data: [{ timeStamp: "2026-10-15T09:00:00Z", total: 0 }, { timeStamp: "2026-10-15T09:05:00Z", total: 0 }] }] }] } }),
    json("inputs/native/log-query.json", { ...P1_HEADER, workspace: "law-west", sourceKind: "log", request: { query: "requests | where success == false | summarize failed = count()", timespan: "2026-10-15T09:00:00Z/2026-10-15T09:10:00Z" }, response: { tables: [{ name: "PrimaryResult", columns: [{ name: "failed", type: "long" }], rows: [[0]] }] } }),
  ];
}

const P2_REQUESTS = {
  "mismatch-cloud-tenant": { cloud: "AzureChinaCloud", tenantId: TENANT_B, subscriptionId: SUB_A, question: "Reuse the saved Http5xx samples for the checkout binding." },
  "mismatch-duplicate-rg-resource-name": { cloud: "AzurePublic", tenantId: TENANT_A, subscriptionId: SUB_B, resourceGroup: "rg-shared", resourceName: "api", resourceId: API_B, question: "Reuse the saved api observations for this api." },
  "mismatch-source-workspace": { cloud: "AzurePublic", tenantId: TENANT_A, workspace: "law-east", sourceKind: "log", question: "Reuse the saved log query result for the east workspace." },
  "mismatch-query-filter-dimensions-aggregation": { cloud: "AzurePublic", tenantId: TENANT_A, query: "requests | where success == true | summarize ok = count()", filter: "Region eq 'westeurope'", dimensions: ["Region"], aggregation: "Average", question: "Reuse the saved samples for this different query, filter, dimension and aggregation." },
  "mismatch-window-currentness": { cloud: "AzurePublic", tenantId: TENANT_A, requestedWindow: "2026-10-17T09:00:00Z/2026-10-17T09:10:00Z", questionAskedAtUtc: "2026-10-17T09:30:00Z", question: "Does the saved window answer the current health question?" },
  "mismatch-operation-cached-approval": { cloud: "AzurePublic", tenantId: TENANT_A, requestedOperation: "signals.bind", cachedApprovalId: "approval-2026-10-15", question: "Bind the signal using the cached approval." },
};

function p3Files() {
  return [
    json("inputs/native/inventory-page-1.json", { operation: "resource-graph.query", capturedAtUtc: "2026-10-15T09:00:00Z", scope: `${SUB_A}/rg-shared`, response: { value: [{ id: API_A, name: "api" }], nextLink: "https://management.example.invalid/inventory?page=2" } }),
    json("inputs/native/inventory-page-2-denied.json", { operation: "resource-graph.query", capturedAtUtc: "2026-10-15T09:00:04Z", scope: `${SUB_A}/rg-shared`, httpStatus: 403, response: { error: { code: "AuthorizationFailed", message: "The client does not have authorization to perform action on the continuation page." } } }),
    json("inputs/native/log-partial-error.json", { operation: "log-analytics.query", capturedAtUtc: "2026-10-15T09:10:00Z", workspace: "law-west", httpStatus: 200, response: { tables: [{ name: "PrimaryResult", columns: [{ name: "timestamp", type: "datetime" }, { name: "n", type: "long" }], rows: [["2026-10-15T09:00:00Z", 3], ["2026-10-15T09:05:00Z", 2]] }], error: { code: "PartialError", message: "Some shards are unavailable." } } }),
    json("inputs/native/entity-history.json", { operation: "healthmodels.entities.history", capturedAtUtc: "2026-10-15T09:10:00Z", entity: "api", response: { value: [{ timestamp: "2026-10-15T09:00:00Z", healthState: "Unknown" }, { timestamp: "2026-10-15T09:05:00Z", healthState: "Unknown" }] } }),
  ];
}

function readAttempt(n, slug, { command, exitCode, stdout, stderr }) {
  return json(`inputs/read-attempts/${n}-${slug}.json`, { command, exitCode, stdout, stderr, capturedAtUtc: "2026-10-14T05:20:00Z" });
}

function h2Turns() {
  return [
    { order: 1, role: "user", text: "Use supplied historical inventory for selected rg-shared scopes in sub-a and sub-b only." },
    { order: 2, role: "user", text: "not yet" },
    { order: 3, role: "user", text: "scope-only approval for historical drafting. no bicep write." },
    { order: 4, role: "user", text: "correction: revise flow and ranking to match the updated brief proposal." },
    { order: 5, role: "user", text: "accepted. keep revised brief and read it back." },
  ];
}

function caseFixtureLibrary() {
  const reviewedTemplate = text("inputs/reviewed/template.json", JSON.stringify({ "x-fixture": FIXTURE_LABEL, $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#", contentVersion: "1.0.0.0", parameters: { owner: { type: "string" }, location: { type: "string" } }, resources: [{ type: "Microsoft.CloudHealth/healthmodels", apiVersion: "2026-09-01-preview", name: "catalog-health-model", location: "[parameters('location')]", tags: { owner: "[parameters('owner')]" } }] }, null, 2));
  const reviewedParams = text("inputs/reviewed/parameters.reviewed.json", JSON.stringify({ "x-fixture": FIXTURE_LABEL, parameters: { owner: { value: "platform" }, location: { value: "westeurope" } } }, null, 2));
  const currentParams = text("inputs/reviewed/parameters.current.json", JSON.stringify({ "x-fixture": FIXTURE_LABEL, parameters: { owner: { value: "payments" }, location: { value: "westeurope" } } }, null, 2));
  const approvalRecord = json("inputs/reviewed/approval.json", {
    target: MODEL_ID,
    operation: "deployment.create",
    approvedTemplate: { path: "inputs/reviewed/template.json", sha256: reviewedTemplate.sha256 },
    approvedParameters: { path: "inputs/reviewed/parameters.reviewed.json", sha256: reviewedParams.sha256 },
    approvedAtUtc: "2026-10-14T06:00:00Z",
  });

  const catalogBrief = (extra) => text(BRIEF, briefText({ target: "catalog-health-model", flows: "catalog lookup: client -> gateway -> api -> db", ...extra }));

  const noBriefBuild = { write: "no-capture-note", brief: "forbid" };

  return {
    "intake-missing-user-flow": [V("missing-user-flow", [], { brief: "required", bicep: "forbid" })],
    "intake-missing-system-flow": [V("missing-system-flow", [], { brief: "required", bicep: "forbid" })],
    "intake-missing-ranked-concerns": [V("missing-ranked-concerns", [], { brief: "required", bicep: "forbid" })],
    "intake-confirmed": [V("confirmed-offline-draft", [], { brief: "required", bicep: "forbid" })],
    "intake-wrong-target": [V("wrong-target-saved-flows", [text(BRIEF, briefText({ target: "catalog-health-model", flows: "catalog lookup: client -> gateway -> api -> db", notes: "Ranked concerns: lookup failures, then latency." }))], { bicep: "forbid", write: "no-capture-note" })],
    "intake-operator-flow": [V("operator-only-no-public-user", [], { brief: "required", bicep: "forbid" })],
    "one-entity-expansion": [V("proposal-only-new-payment-branch", [catalogBrief({})], { brief: "changed", changed: [BRIEF], write: "no-capture-note" })],
    "tuning-introduces-objective": [V("reject-unreviewed-objective-swap", [catalogBrief({ notes: "Reviewed metric: API latency (average response time)." })], { brief: "changed", changed: [BRIEF], write: "no-capture-note" })],
    "changed-root-rollup": [V("diagnostic-branch-to-root", [catalogBrief({ notes: "Diagnostic branch: queue-monitor, disconnected from the root." })], { brief: "changed", changed: [BRIEF], write: "no-capture-note" })],
    "consumer-threshold-tuning": [V("latency-threshold-800-to-900", [reIndexFile("inputs/reviewed/main.bicep", modelBicep().content)], { ...noBriefBuild })],
    "learn-without-tools": [V("tools-unavailable-explanation-only", [], { write: "none" })],
    "missing-bicep": [V("bicep-unavailable-offline-review", [], { write: "no-capture-note", brief: "forbid" })],
    "writable-import-preservation": [V("import-complete-change-tags-owner-only", [reIndexFile("inputs/baseline/main.bicep", modelBicep().content), json("inputs/native-readback.json", modelReadback())], { ...noBriefBuild })],
    "incomplete-import": [V("detect-unmapped-and-unfetched-page", [json("inputs/native-readback.json", modelReadback({ unmappedField: true, nextLink: true })), reIndexFile("inputs/baseline/main.bicep", modelBicep().content)], { ...noBriefBuild })],
    "refuse-direct-configuration-write": [V("reject-direct-patch-route", [], { write: "none" })],
    "refused-bootstrap": [V("identity-required-user-refused-bootstrap", [], { write: "none" })],
    "changed-reviewed-artifacts": [V("approval-invalidated-by-parameter-change", [reviewedTemplate, reviewedParams, currentParams, approvalRecord], { write: "none" })],
    "approved-current-annotation": [V("approved-current-annotation-simulate-only", [json("inputs/annotation-review.json", {
      approval: { operation: "annotation-write", approvedBy: "fictional-operator", approvedAtUtc: "2026-10-14T05:30:00Z", targetEntityId: `${MODEL_ID}/entities/api`, body: "Deployment of api build 1842 started.", eventTimeUtc: "2026-10-14T05:25:00Z" },
      callerEvidence: { permissionReadback: { principal: "fictional-operator", role: "Health Model Contributor", scope: MODEL_ID }, command: `az rest --method put --url ${MODEL_ID}/entities/api/annotations/1842?api-version=2026-09-01-preview` },
    })], { write: "none" })],
    "ambiguous-annotation-response": [V("lost-response-ambiguous-recent-annotations", [json("inputs/recent-annotations.json", {
      target: `${MODEL_ID}/entities/api`,
      approvedPayload: { body: "Deployment of api build 1842 started.", eventTimeUtc: "2026-10-14T05:25:00Z" },
      listedAtUtc: "2026-10-14T05:41:00Z",
      response: { value: [{ name: "a-17", properties: { body: "Deployment of api build 1842 started.", eventTimeUtc: "2026-10-14T05:25:00Z", createdBy: "automation-1" } }, { name: "a-18", properties: { body: "Deployment of api build 1842 started.", eventTimeUtc: "2026-10-14T05:25:00Z", createdBy: "fictional-operator" } }] },
    })], { write: "none" })],
    "failed-principal-readback": [V("post-bootstrap-readback-failed", [], { write: "none" })],
    "pending-model-access": [V("grant-propagating-alt-uai-unverified", [], { write: "none" })],
    "absent-input-zero-result": [V("zero-result-with-empty-rows-and-identity-denied", [], { write: "none" })],
    "measured-zero": [V("zero-error-count-reviewed-window", [json("inputs/source-and-evaluation.json", {
      window: "2026-10-14T05:00:00Z/2026-10-14T05:10:00Z",
      source: { operation: "log-analytics.query", query: "requests | where success == false | summarize errors = count()", response: { tables: [{ name: "PrimaryResult", columns: [{ name: "errors", type: "long" }], rows: [[0]] }], rowsScanned: 214 } },
      evaluation: { entity: "api", signal: "error-count", value: 0, rule: "GreaterThan 5 is Degraded", windowEndUtc: "2026-10-14T05:10:00Z" },
    })], { write: "none" })],
    "partial-or-malformed-source": [V("partialerror-and-missing-result-table", [json("inputs/source-outcomes.json", {
      outcomes: [
        { id: "a", httpStatus: 200, response: { tables: [{ name: "PrimaryResult", columns: [{ name: "n", type: "long" }], rows: [[7]] }], error: { code: "PartialError", message: "Some shards are unavailable." } } },
        { id: "b", httpStatus: 200, response: { tables: [] } },
      ],
    })], { write: "none" })],
    "default-resource-health": [V("resource-health-default-vs-empty", [
      text("inputs/candidate-omitted.bicep", `${BICEP_HEADER}resource api 'Microsoft.CloudHealth/healthmodels/entities@2026-09-01-preview' = {\n  name: 'catalog-health-model/api'\n  properties: {\n    signalGroups: {\n      azureResource: {\n        azureResourceId: '${API_A}'\n        authenticationSetting: 'model-identity'\n      }\n    }\n  }\n}`),
      text("inputs/candidate-empty.bicep", `${BICEP_HEADER}resource api 'Microsoft.CloudHealth/healthmodels/entities@2026-09-01-preview' = {\n  name: 'catalog-health-model/api'\n  properties: {\n    signalGroups: {\n      azureResource: {\n        azureResourceId: '${API_A}'\n        authenticationSetting: 'model-identity'\n        resourceHealth: {}\n      }\n    }\n  }\n}`),
      text("inputs/caller-source-list.md", "Caller-maintained source list (fictional)\n\n- api: Resource Health, no access checks needed.\n- db: Resource Health, no access checks needed.\n"),
    ], { write: "no-capture-note", brief: "forbid" })],
    "discovery-only-gaps": [V("discovery-only-unresolved-access", [], { write: "none" })],
    "history-utc-and-pagination": [V("history-window-with-repeated-nextmarker", [], { write: "none" })],
    "history-repeat-and-carry-in": [V("second-window-carry-in-only", [
      json("inputs/history-window-2.json", {
        entity: "api",
        requestedWindowUtc: "2026-10-14T09:00:00Z/2026-10-14T09:10:00Z",
        pages: [
          { page: 1, request: { startTime: "2026-10-14T09:00:00Z", endTime: "2026-10-14T09:10:00Z" }, response: { value: [{ timestamp: "2026-10-14T05:41:12Z", healthState: "Degraded" }, { timestamp: "2026-10-14T06:12:40Z", healthState: "Healthy" }], nextMarker: "m2" } },
          { page: 2, request: { marker: "m2" }, response: { value: [{ timestamp: "2026-10-14T07:03:55Z", healthState: "Unknown" }] } },
        ],
      }),
      json("inputs/prior-observation.json", { entity: "api", observedAtUtc: "2026-10-13T08:00:00Z", healthState: "Healthy", window: "2026-10-13T07:50:00Z/2026-10-13T08:00:00Z" }),
    ], { write: "none" })],
    "stable-flow-backend-replacement": [V("replace-backend-preserve-stable-entity", [json("inputs/model-readback.json", modelReadback()), reIndexFile("inputs/baseline/main.bicep", modelBicep().content)], { ...noBriefBuild })],
    "signal-history-identity": [V("instance-update-vs-recreate-vs-label-change", [], { write: "none" })],
    "implicit-root-and-shared-dependency": [V("shared-dependency-with-disconnected-diagnostic", [json("inputs/model-graph.json", {
      model: "catalog-health-model",
      entities: ["catalog-health-model", "checkout-flow", "orders", "inventory", "shared-db", "queue-monitor"],
      relationships: [{ parentEntityName: "catalog-health-model", childEntityName: "checkout-flow" }, { parentEntityName: "checkout-flow", childEntityName: "orders" }, { parentEntityName: "checkout-flow", childEntityName: "inventory" }, { parentEntityName: "orders", childEntityName: "shared-db" }, { parentEntityName: "inventory", childEntityName: "shared-db" }],
    })], { ...noBriefBuild })],
    "layout-only-change": [V("move-one-node-preserve-rest", [json("inputs/layout-import.json", {
      model: "catalog-health-model",
      canvas: { nodes: [{ entity: "gateway", x: 20, y: 40 }, { entity: "api", x: 180, y: 40 }, { entity: "db", x: 340, y: 40 }], moveRequest: { entity: "db", x: 340, y: 120 } },
    })], { ...noBriefBuild })],
    "native-preview-not-deployment": [V("preview-and-notfound-not-lifecycle-proof", [], { write: "none" })],
    "absence-versus-read-failure": [V("distinguish-notfound-auth-malformed-incomplete", [
      readAttempt("01", "notfound", { command: `az rest --method get --url ${MODEL_ID}/entities/missing?api-version=2026-09-01-preview`, exitCode: 3, stdout: "", stderr: "ERROR: (ResourceNotFound) The entity 'missing' could not be found." }),
      readAttempt("02", "authorization", { command: `az rest --method get --url ${MODEL_ID}/entities/api?api-version=2026-09-01-preview`, exitCode: 1, stdout: "", stderr: "ERROR: (AuthorizationFailed) The client does not have authorization to perform action." }),
      readAttempt("03", "malformed", { command: `az rest --method get --url ${MODEL_ID}/entities/db?api-version=2026-09-01-preview`, exitCode: 0, stdout: "{\"name\": \"db\", \"properties\": {", stderr: "" }),
      readAttempt("04", "incomplete", { command: `az rest --method get --url ${MODEL_ID}/entities?api-version=2026-09-01-preview`, exitCode: 0, stdout: JSON.stringify({ value: [{ name: "gateway" }], nextLink: "https://management.example.invalid/entities?$skiptoken=p2" }), stderr: "" }),
    ], { write: "free", bicep: "forbid" })],
    "cleanup-ownership-and-history": [V("prepare-cleanup-no-execution", [json("inputs/cleanup-state.json", {
      model: "catalog-health-model",
      stackManaged: [{ name: "gateway" }, { name: "api" }],
      unmanagedRemainder: [{ name: "manual-note-entity" }],
      discoveryOwnedChildren: [{ name: "disc-queue-1", discoveryRuleName: "auto-discover-queues" }],
      lastDeleteReadback: { operation: "delete", name: "api-latency-def", properties: { provisioningState: "deleteFailed" } },
    })], { write: "none" })],
    "healthy-headline-unknown-numeric": [V("healthy-entities-unknown-numeric-no-source-query", [], { write: "none" })],
    "provisioning-succeeded-evaluation-failed": [V("provisioning-ok-latest-eval-auth-error", [json("inputs/readback.json", {
      model: "catalog-health-model",
      properties: { provisioningState: "Succeeded" },
      children: ["gateway", "api", "db"],
      bindings: [{ entity: "api", azureResourceId: API_A, authenticationSetting: "model-identity" }],
      latestEvaluation: { entity: "api", signal: "latency", timestamp: "2026-10-14T05:10:00Z", error: { code: "AuthorizationFailed", message: "Model identity cannot read the source." } },
    })], { write: "none" })],
    "c4-h1": [V("missing-scope-then-ambiguous-rg", [], { write: "none" })],
    "c4-h2": [V("ordered-refusal-scope-correction-acceptance", [inventoryCapture()], { brief: "required", bicep: "forbid" }, { turns: h2Turns() })],
    "c4-h3": [
      V("same-target-update", [
        json("inputs/model-source.json", { ...modelReadback({ nextLink: true }), definitions: [{ name: "latency-def", threshold: { operator: "GreaterThan", value: 800 } }], inlineOverrides: [{ entity: "api", signal: "latency", threshold: { operator: "GreaterThan", value: 900 } }], observations: [{ entity: "api", signal: "latency", timestamp: "2026-10-14T05:10:00Z", healthState: "Unknown" }] }),
        text(BRIEF, briefText({ target: "catalog-health-model", flows: "submit -> receipt", notes: "User notes: keep latency concerns first." })),
        json("captures/older-readback.json", { operation: "healthmodels.get", capturedAtUtc: "2026-10-13T08:00:00Z", scope: MODEL_ID, response: { name: "catalog-health-model" } }),
      ], { brief: "changed", changed: [BRIEF], bicep: "forbid", write: "free" }),
      V("wrong-target-awaiting-choice", [
        json("inputs/model-source.json", { ...modelReadback({ nextLink: true }), definitions: [{ name: "latency-def", threshold: { operator: "GreaterThan", value: 800 } }], inlineOverrides: [{ entity: "api", signal: "latency", threshold: { operator: "GreaterThan", value: 900 } }], observations: [{ entity: "api", signal: "latency", timestamp: "2026-10-14T05:10:00Z", healthState: "Unknown" }] }),
        text(BRIEF, briefText({ target: "payments-health-model", flows: "charge -> capture" })),
        json("captures/older-readback.json", { operation: "healthmodels.get", capturedAtUtc: "2026-10-13T08:00:00Z", scope: MODEL_ID, response: { name: "catalog-health-model" } }),
      ], { bicep: "forbid", write: "free" }),
    ],
    "c4-h4": [
      V("missing-tools-offline-context", [json("inputs/offline-context.json", { capturedAtUtc: "2026-10-14T05:00:00Z", scope: `${SUB_A}/rg-shared`, resources: [{ id: API_A, name: "api", type: "Microsoft.Web/sites" }, { id: DB_A, name: "db", type: "Microsoft.Sql/servers" }] })], { brief: "required", bicep: "forbid" }),
      V("authorizationfailed-next-page", [
        json("inputs/inventory-page-1.json", { operation: "resource-graph.query", capturedAtUtc: "2026-10-14T05:00:00Z", scope: `${SUB_A}/rg-shared`, response: { value: [{ id: DB_A, name: "db" }], nextLink: "https://management.example.invalid/inventory?page=2" } }),
        json("inputs/inventory-page-2-error.json", { operation: "resource-graph.query", capturedAtUtc: "2026-10-14T05:00:03Z", scope: `${SUB_A}/rg-shared`, httpStatus: 403, response: { error: { code: "AuthorizationFailed", message: "The client does not have authorization to perform action 'read'." } } }),
      ], { brief: "required", bicep: "forbid" }),
      V("no-writable-files-repeat-h2", [inventoryCapture()], { write: "no-persist", bicep: "forbid", denied: ["brief"] }, {
        turns: h2Turns(),
        permissionPolicy: { operationPermissions: { allowCaptureWrite: false, allowEvidenceNoteWrite: false } },
        deniedOperations: [deny("capture", "captures/", "writable-permission-denied"), deny("note", "notes/", "writable-permission-denied"), deny("brief", ".healthmodel/", "writable-permission-denied")],
      }),
    ],
    "c4-h5": [
      V("consumer-threshold-edit", [reIndexFile("inputs/reviewed/main.bicep", modelBicep().content)], { ...noBriefBuild }),
      V("new-payment-dependency-called-small", [catalogBrief({}), reIndexFile("inputs/reviewed/main.bicep", modelBicep().content)], { brief: "changed", changed: [BRIEF], write: "no-capture-note" }),
    ],
    "genuine-unhealthy-evaluation": [V("matching-source-and-evaluation-unhealthy", [json("inputs/observations.json", {
      window: "2026-10-14T05:00:00Z/2026-10-14T05:10:00Z",
      source: { operation: "log-analytics.query", query: "requests | where success == false | summarize failed = count()", response: { tables: [{ name: "PrimaryResult", columns: [{ name: "failed", type: "long" }], rows: [[12]] }] } },
      evaluation: { entity: "api", signal: "failed-requests", value: 12, healthState: "Unhealthy", rule: { operator: "GreaterThan", threshold: 10 } },
      propagation: [{ entity: "api", healthState: "Unhealthy" }, { entity: "checkout-flow", healthState: "Unhealthy" }, { entity: "catalog-health-model", healthState: "Unhealthy" }],
    })], { write: "none" })],
    "c5-p1": [V("observe-save-then-fresh-signals-session", p1Files(), { write: "free", bicep: "forbid", require: ["captures/**"] }, {
      turns: [
        { order: 1, role: "user", skill: "healthmodel-observe", text: "In a verified private consumer, retain supplied fictional native resources, relationships, metric definitions, samples and log/query captures as observations without querying or judging health. Supplied files: inputs/native/resources.json, inputs/native/relationships.json, inputs/native/metric-definitions.json, inputs/native/metric-samples.json, inputs/native/log-query.json. Files under inputs/ are read-only. Retained observations may be written under captures/ (and notes under notes/)." },
        { order: 2, role: "user", skill: "healthmodel-signals", session: "new", carry: "filesystem-only", text: `Which retained observation matches the historical target ${API_A} (metric Http5xx, Total, 5-minute interval, Instance api-0) for the window 2026-10-15T09:00:00Z/2026-10-15T09:10:00Z, and what binding does it support?` },
      ],
      requestedReplayOperations: [{ operation: "signals.start-fresh-session", constraints: { carry: "filesystem-only", transcriptCarry: false } }],
    })],
    "c5-p2": Object.entries(P2_REQUESTS).map(([id, body]) =>
      V(id, [json("inputs/request.json", body)], { write: "free", bicep: "forbid", forbidOps: ["capture"] }, { dependencyArtifactRefs: [{ caseId: "c5-p1", required: true, artifact: "artifactManifest" }] })),
    "c5-p3": [
      V("successful-captures-and-denied-continuations", p3Files(), { require: ["captures/**"], bicep: "forbid" }, { turns: p3Turns() }),
      V("deny-capture-write", p3Files(), { denied: ["capture"], write: "free", bicep: "forbid", forbid: ["captures/**"] }, { turns: p3Turns(), deniedOperations: [deny("capture", "captures/", "path-denied")] }),
      V("deny-evidence-note-write", p3Files(), { denied: ["note"], bicep: "forbid", forbid: ["notes/**"], require: ["captures/**"] }, { turns: p3Turns(), deniedOperations: [deny("note", "notes/", "path-denied")] }),
    ],
    "c5-p4": [
      V("protected-outside-git-consumer", [], { bicep: "forbid", consumer: "private-outside-git" }, { permissionPolicy: { privacyGuards: { requireOutsideGitConsumer: true, requireOwnerOnlyPermissions: true } } }),
      V("unsafe-consumer-pauses", [json("inputs/destination.json", { requestedDestination: ".promptfoo/consumer-candidate", note: "Store the observations in this destination." })], { write: "none", consumer: "inside-git-candidate" }, { consumerCandidate: { kind: "inside-git-candidate", relativePath: ".promptfoo/consumer-candidate" } }),
      V("unverified-consumer-pauses", [json("inputs/destination.json", { requestedDestination: "consumer-unverified", note: "Store the observations in this destination." })], { write: "none", consumer: "unverified-consumer" }, { consumerCandidate: { kind: "unverified-consumer", relativePath: "consumer-unverified" } }),
      V("capture-name-collision", [json("captures/inventory.json", { operation: "resource-graph.query", capturedAtUtc: "2026-10-13T08:00:00Z", scope: `${SUB_A}/rg-shared`, response: { value: [{ id: API_A, name: "api" }] } }), json("inputs/new-inventory.json", { operation: "resource-graph.query", capturedAtUtc: "2026-10-14T05:00:00Z", scope: `${SUB_A}/rg-shared`, requestedCapturePath: "captures/inventory.json", response: { value: [{ id: DB_A, name: "db" }] } })], { bicep: "forbid" }),
      V("missing-or-ambiguous-scope", [], { write: "none" }),
      V("scope-only-refused-review", [], { bicep: "forbid" }),
      V("wrong-target-brief", [text(BRIEF, briefText({ target: "payments-health-model", flows: "charge -> capture" }))], { bicep: "forbid", write: "no-capture-note" }),
    ],
    "c9-observe-scope-and-alert-leads": [V("scope-a-b-with-duplicate-names-and-alert-lead", [
      json("inputs/inventory-pages.json", { pages: [
        { scope: `${SUB_A}/rg-shared`, response: { value: [{ id: API_A, name: "api" }, { id: DB_A, name: "db" }] } },
        { scope: `${SUB_B}/rg-shared`, response: { value: [{ id: API_B, name: "api" }], nextLink: "https://management.example.invalid/inventory?page=2" } },
        { scope: `${SUB_B}/rg-shared`, httpStatus: 403, response: { error: { code: "AuthorizationFailed", message: "Continuation page denied." } } },
      ] }),
      json("inputs/alert.json", { name: "api-5xx", properties: { scopes: [rid(SUB_C, "rg-other", "Microsoft.Web/sites", "api-other")], severity: 2 } }),
    ], { write: "free", bicep: "forbid" })],
    "c9-query-source-outcomes": [V("metric-kql-promql-outcome-matrix", [json("inputs/source-outcomes.json", {
      reviewedIntent: "failed checkout requests",
      outcomes: [
        { id: "metric-no-samples", request: { path: `${API_A}/providers/Microsoft.Insights/metrics`, query: { metricnames: "Http5xx", aggregation: "Total", timespan: "2026-10-14T05:00:00Z/2026-10-14T05:10:00Z" } }, response: { value: [{ name: { value: "Http5xx" }, unit: "Count", timeseries: [] }] } },
        { id: "kql-empty-input", request: { query: "AppRequests | where Success == false | summarize failed = count()" }, response: { tables: [{ name: "PrimaryResult", columns: [{ name: "failed", type: "long" }], rows: [[0]] }], statistics: { inputRows: 0 } } },
        { id: "kql-partial-error", httpStatus: 200, response: { tables: [{ name: "PrimaryResult", columns: [{ name: "failed", type: "long" }], rows: [[4]] }], error: { code: "PartialError" } } },
        { id: "kql-denied", httpStatus: 403, response: { error: { code: "AuthorizationFailed" } } },
        { id: "promql-absent-input-fallback", request: { query: "sum(rate(checkout_failed_total[5m])) or vector(0)" }, response: { status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [1760418000, "0"] }] } }, note: "series checkout_failed_total has no samples in the window" },
        { id: "multiple-series", request: { query: "sum by (instance) (rate(checkout_failed_total[5m]))" }, response: { status: "success", data: { resultType: "vector", result: [{ metric: { instance: "api-0" }, value: [1760418000, "0.2"] }, { metric: { instance: "api-1" }, value: [1760418000, "0.4"] }] } } },
        { id: "measured-zero", request: { path: `${API_A}/providers/Microsoft.Insights/metrics`, query: { metricnames: "Http5xx", aggregation: "Total" } }, response: { value: [{ name: { value: "Http5xx" }, timeseries: [{ data: [{ timeStamp: "2026-10-14T05:00:00Z", total: 0 }, { timeStamp: "2026-10-14T05:05:00Z", total: 0 }] }] }] } },
      ],
    })], { write: "none" })],
    "c9-signal-fragment-and-stable-instance": [V("shared-definition-reorder-and-tune-one-binding", [
      reIndexFile("inputs/model/main.bicep", modelBicep().content),
      json("inputs/alert-suggestion.json", { name: "api-latency-alert", properties: { severity: 0, actionGroups: ["ag-pager"], criteria: { metricName: "HttpResponseTime", threshold: 500 } } }),
    ], { ...noBriefBuild })],
    "c9-bounded-removal": [
      V("remove-manual-entity", [reIndexFile("inputs/baseline/main.bicep", modelBicep({ legacyQueue: true }).content), json("inputs/native-readback.json", modelReadback({ discoveryOwnedEntity: null }))], { ...noBriefBuild }),
      V("discovery-owned-entity", [reIndexFile("inputs/baseline/main.bicep", modelBicep({ legacyQueue: true }).content), json("inputs/native-readback.json", modelReadback({ discoveryOwnedEntity: "legacy-queue" }))], { ...noBriefBuild }),
      V("unmapped-writable-field", [reIndexFile("inputs/baseline/main.bicep", modelBicep({ legacyQueue: true }).content), json("inputs/native-readback.json", modelReadback({ unmappedField: true }))], { ...noBriefBuild }),
    ],
    "c9-rollup-impact-custom-groups": [
      V("native-aggregation-semantics-supplied", [reIndexFile("inputs/model/main.bicep", modelBicep().content), text("inputs/aggregation-semantics.md", "Excerpt (fictional, for this fixture)\n\nsignalAggregationGroups[].aggregationType: WorstOf | BestOf | MinHealthy | MaxNotHealthy\nmembers[]: signal instance names on the same entity\n")], { ...noBriefBuild }),
      V("native-aggregation-semantics-unavailable", [reIndexFile("inputs/model/main.bicep", modelBicep().content)], { ...noBriefBuild }),
    ],
  };
}

function validateObservationReference(name) {
  if (!isNonEmptyString(name)) {
    throw new Error("Observation name must be a non-empty string.");
  }
  if (path.isAbsolute(name) || name.includes("..") || name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid observation path '${name}'. Only bare filenames are allowed.`);
  }
}

function validateCaseShape(caseRecord) {
  if (!isNonEmptyString(caseRecord?.name)) {
    throw new Error("Each case must include a non-empty name.");
  }
  if (!isNonEmptyString(caseRecord?.category) || !isNonEmptyString(caseRecord?.skill) || !isNonEmptyString(caseRecord?.task)) {
    throw new Error(`Case '${caseRecord?.name ?? "unknown"}' has invalid category/skill/task.`);
  }
  if (!Array.isArray(caseRecord.expected) || caseRecord.expected.length === 0 || caseRecord.expected.some((entry) => !isNonEmptyString(entry))) {
    throw new Error(`Case '${caseRecord.name}' has invalid expected[] shape.`);
  }
  if (caseRecord.observations !== undefined && (!Array.isArray(caseRecord.observations) || caseRecord.observations.some((entry) => !isNonEmptyString(entry)))) {
    throw new Error(`Case '${caseRecord.name}' has invalid observations[] shape.`);
  }
}

export async function loadSourceCases() {
  const raw = await readFile(SOURCE_CASES_PATH, "utf8");
  const cases = JSON.parse(raw);
  if (!Array.isArray(cases)) {
    throw new Error("cases.json must be an array.");
  }
  const nameSet = new Set();
  for (const caseRecord of cases) {
    validateCaseShape(caseRecord);
    if (nameSet.has(caseRecord.name)) {
      throw new Error(`Duplicate case name '${caseRecord.name}' in source corpus.`);
    }
    nameSet.add(caseRecord.name);
    for (const obs of caseRecord.observations ?? []) {
      validateObservationReference(obs);
    }
  }
  return { raw, cases, sha256: sha256(raw) };
}

export async function readObservationFile(observationName, root = OBSERVATION_ROOT) {
  validateObservationReference(observationName);
  const absolutePath = path.join(root, observationName);
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Observation '${observationName}' must not be a symlink.`);
  }
  const real = await realpath(absolutePath);
  const realRoot = await realpath(root);
  if (!real.startsWith(`${realRoot}${path.sep}`) && real !== realRoot) {
    throw new Error(`Observation '${observationName}' escapes observation root.`);
  }
  const content = await readFile(real, "utf8");
  return {
    name: observationName,
    sourcePath: path.join("tests", "fixtures", "workflows", observationName),
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content),
  };
}

function buildObservationRefs(caseRecord) {
  return (caseRecord.observations ?? []).map((name) => ({
    name,
    sourcePath: path.join("tests", "fixtures", "workflows", name),
  }));
}

function validateFixtureCoverage(sourceCases, fixtureMap) {
  const sourceIds = sourceCases.map((entry) => entry.name);
  const missing = sourceIds.filter((id) => !fixtureMap[id]);
  if (missing.length > 0) {
    throw new Error(`Missing explicit fixture definitions for cases: ${missing.join(", ")}`);
  }
  const unknown = Object.keys(fixtureMap).filter((id) => !sourceIds.includes(id));
  if (unknown.length > 0) {
    throw new Error(`Fixture definitions include unknown case IDs: ${unknown.join(", ")}`);
  }
}

function mergePolicy(base, override) {
  if (!override) return base;
  return {
    consumerKind: override.consumerKind ?? base.consumerKind,
    localPathPermissions: { ...base.localPathPermissions, ...(override.localPathPermissions ?? {}) },
    operationPermissions: { ...base.operationPermissions, ...(override.operationPermissions ?? {}) },
    privacyGuards: { ...base.privacyGuards, ...(override.privacyGuards ?? {}) },
  };
}

export async function buildScenarioPlans(sourceCasesInput, fixtureMapOverride = null) {
  const sourceCases = sourceCasesInput ?? (await loadSourceCases()).cases;
  const fixtureMap = fixtureMapOverride ?? caseFixtureLibrary();
  validateFixtureCoverage(sourceCases, fixtureMap);
  const plans = {};

  for (const caseRecord of sourceCases) {
    const publicTask = file("inputs/public-task.md", caseRecord.task, "source-task");
    const variants = fixtureMap[caseRecord.name].map((variant) => {
      const paths = [publicTask.path, ...variant.files.map((entry) => entry.path)];
      if (new Set(paths).size !== paths.length) {
        throw new Error(`Variant '${caseRecord.name}/${variant.id}' stages duplicate paths.`);
      }
      return {
        ...variant,
        files: [publicTask, ...variant.files],
        observationRefs: buildObservationRefs(caseRecord),
        turns: variant.turns.length > 0 ? variant.turns : [{ order: 1, role: "user", text: caseRecord.task }],
        permissionPolicy: mergePolicy(basePolicy(), variant.permissionPolicy),
      };
    });

    plans[caseRecord.name] = {
      caseId: caseRecord.name,
      sourceCaseName: caseRecord.name,
      category: caseRecord.category,
      skill: caseRecord.skill,
      expectedCount: caseRecord.expected.length,
      variantCount: variants.length,
      variants,
    };
  }
  return plans;
}

export function validateP1ArtifactManifest(priorArtifacts) {
  const p1 = priorArtifacts?.["c5-p1"];
  if (!p1 || !isNonEmptyString(p1.status) || !Array.isArray(p1.artifactManifest) || p1.artifactManifest.length === 0) {
    return false;
  }
  const seenPaths = new Set();
  return p1.artifactManifest.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    if (!isNonEmptyString(entry.path) || path.isAbsolute(entry.path) || entry.path.split("/").includes("..")) return false;
    if (!inWriteRoot(entry.path)) return false;
    if (seenPaths.has(entry.path)) return false;
    seenPaths.add(entry.path);
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")) return false;
    if (typeof entry.bytes !== "number" || entry.bytes <= 0) return false;
    if (!isNonEmptyString(entry.content) || !isNonEmptyString(entry.provenance)) return false;
    if (sha256(entry.content) !== entry.sha256) return false;
    if (Buffer.byteLength(entry.content, "utf8") !== entry.bytes) return false;
    return true;
  });
}

export async function prepareScenario(caseId, variantId = null, priorArtifacts = {}) {
  const source = await loadSourceCases();
  const selected = source.cases.find((entry) => entry.name === caseId);
  if (!selected) {
    throw new Error(`Unknown caseId '${caseId}'.`);
  }
  const plans = await buildScenarioPlans(source.cases);
  const plan = plans[caseId];
  const selectedVariantId = variantId ?? plan.variants[0].id;
  const variant = plan.variants.find((entry) => entry.id === selectedVariantId);
  if (!variant) {
    throw new Error(`Unknown variant '${selectedVariantId}' for case '${caseId}'.`);
  }

  if (caseId === "c5-p2" && !validateP1ArtifactManifest(priorArtifacts)) {
    return {
      status: "blocked",
      caseId,
      variantId: selectedVariantId,
      blockingReason: "c5-p2 requires c5-p1 artifact manifest with verified provenance, bytes, content, and sha256.",
      missingDependencies: ["c5-p1.artifactManifest"],
    };
  }

  const observationFiles = {};
  for (const obs of selected.observations ?? []) {
    observationFiles[obs] = await readObservationFile(obs);
  }

  const p1Saved = caseId === "c5-p2"
    ? priorArtifacts["c5-p1"].artifactManifest.map((entry) => file(entry.path, entry.content, "c5-p1-saved-bytes"))
    : [];
  const stagedPaths = new Set(variant.files.map((entry) => entry.path));
  const clashing = p1Saved.find((entry) => stagedPaths.has(entry.path));
  if (clashing) {
    throw new Error(`c5-p1 saved path '${clashing.path}' collides with a staged fixture path.`);
  }
  const resolvedFiles = [...variant.files, ...p1Saved];

  return {
    status: "ready",
    caseId,
    sourceCaseName: selected.name,
    variantId: selectedVariantId,
    consumerKind: variant.consumerKind,
    consumerCandidate: variant.consumerCandidate,
    expectedBundleCaseId: selected.name,
    files: resolvedFiles,
    requiredFiles: resolvedFiles.map((entry) => entry.path),
    inputFiles: resolvedFiles
      .map((entry) => entry.path)
      .filter((entry) => entry.startsWith("inputs/")),
    observations: variant.observationRefs ?? [],
    observationMap: observationFiles,
    turns: variant.turns,
    permissionPolicy: variant.permissionPolicy,
    deniedOperations: variant.deniedOperations,
    outputLayout: { capturePrefix: "captures/", notePrefix: "notes/", briefPrefix: ".healthmodel/" },
    gateSpec: {
      ...variant.gateSpec,
      preservedArtifacts: [
        ...variant.gateSpec.preservedArtifacts,
        ...p1Saved.map(({ path: p, sha256: h, bytes }) => ({ path: p, sha256: h, bytes })),
      ],
    },
    dependencyArtifactRefs: variant.dependencyArtifactRefs,
    requestedReplayOperations: variant.requestedReplayOperations,
    priorArtifactsUsed: caseId === "c5-p2" ? priorArtifacts["c5-p1"].artifactManifest : [],
  };
}

export function listRequiredCases() {
  return [...REQUIRED_CASES];
}
