import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { createObservationTool, createRehearsalTool } from "./azure-readonly.mjs";

const SCOPE = {
  subscriptionId: "6fc552c5-06b6-43d7-ac70-2f1eda1be033",
  resourceGroups: ["rg-alwaysonn-global", "rg-alwaysonn-swedencentral"],
};

for (const createTool of [createObservationTool, createRehearsalTool]) {
  test(`${createTool.name} exposes an object-root schema for native registration`, () => {
    const tool = createTool({
      mode: "recorded",
      scope: SCOPE,
      captureSet: buildCaptureSet("always-on-04"),
      workspaceRoot: "/workspace",
      evidenceRoot: "/evidence",
      caseId: "always-on-04",
      validationId: null,
    });
    assert.equal(tool.parameters.type, "object");
    if (createTool === createRehearsalTool) {
      assert.deepEqual(
        tool.parameters.oneOf.map((variant) => ({
          action: variant.properties.action.const,
          required: variant.required,
          additionalProperties: variant.additionalProperties,
        })),
        [
          { action: "inspect", required: ["action", "packagePath"], additionalProperties: false },
          {
            action: "execute",
            required: ["action", "packagePath", "operation", "claimedTargets"],
            additionalProperties: false,
          },
        ]
      );
    }
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function validWorkspaceResourceId() {
  return "/subscriptions/6fc552c5-06b6-43d7-ac70-2f1eda1be033/resourceGroups/rg-alwaysonn-global/providers/Microsoft.OperationalInsights/workspaces/ws-01";
}

function validPromAccountResourceId() {
  return "/subscriptions/6fc552c5-06b6-43d7-ac70-2f1eda1be033/resourceGroups/rg-alwaysonn-swedencentral/providers/Microsoft.Monitor/accounts/amw-alwaysonn-swedencentral";
}

function buildCaptureSet(caseId = "always-on-02") {
  const capturePayload = {
    request: {
      workspaceResourceId: validWorkspaceResourceId(),
      query: "Heartbeat | take 1",
      timespan: "PT1H",
    },
    result: {
      rows: [{ Computer: "vm-01", state: "Healthy" }],
      secret: "redact-me",
    },
    completedAt: "2026-10-18T08:01:00.000Z",
  };
  const captureContent = `${JSON.stringify(capturePayload, null, 2)}\n`;
  const reviewPayload = {
    label: "benchmark-test-review",
    suiteId: "always-on-five-v1",
    caseId,
    approvedPackagePath: "approved-package",
    approvedOperations: ["prom.query"],
    approvedTargets: ["darkux-66", "darkux-67"],
  };
  const reviewContent = `${JSON.stringify(reviewPayload, null, 2)}\n`;
  const oraclePayload = {
    approvedPackagePath: "approved-package",
    reviewRecord: "reviews/always-on-04-darkux-benchmark-rehearsal-review.json",
    approvedContentSha256: "f".repeat(64),
  };
  const oracleContent = `${JSON.stringify(oraclePayload, null, 2)}\n`;
  const hostSchemaPayload = {
    result: {
      id: validPromAccountResourceId().toLowerCase(),
      type: "Microsoft.Monitor/accounts",
      properties: {
        metrics: {
          prometheusQueryEndpoint:
            "https://amw-alwaysonn-swedencentral-gqd8h0ctg5cjajej.swedencentral.prometheus.monitor.azure.com",
        },
      },
    },
  };
  const hostSchemaContent = `${JSON.stringify(hostSchemaPayload, null, 2)}\n`;
  return {
    suiteId: "always-on-five-v1",
    entries: [
      {
        path: "captures/logs-heartbeat.json",
        sha256: sha256(captureContent),
        kind: "capture",
        visibility: "agent",
        caseIds: [caseId],
        content: captureContent,
      },
      {
        path: "host/approval-oracle.json",
        sha256: sha256(oracleContent),
        kind: "schema",
        visibility: "host",
        caseIds: [caseId],
        content: oracleContent,
      },
      {
        path: "host/prom-query-endpoints.json",
        sha256: sha256(hostSchemaContent),
        kind: "schema",
        visibility: "host",
        caseIds: [caseId],
        content: hostSchemaContent,
      },
      {
        path: "reviews/always-on-04-darkux-benchmark-rehearsal-review.json",
        sha256: sha256(reviewContent),
        kind: "review",
        visibility: "agent",
        caseIds: [caseId],
        content: reviewContent,
      },
    ],
  };
}

async function listReceiptPayloads(evidenceRoot, caseId) {
  const dir = path.join(evidenceRoot, caseId);
  const files = await readdir(dir);
  const receipts = [];
  for (const file of files) {
    const body = await readFile(path.join(dir, file), "utf8");
    receipts.push(JSON.parse(body));
  }
  return receipts;
}

test("createObservationTool recorded mode resolves capture and writes receipt", async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-recorded-"));
  const tool = createObservationTool({
    mode: "recorded",
    scope: SCOPE,
    captureSet: buildCaptureSet("always-on-02"),
    evidenceRoot,
    validationId: null,
    caseId: "always-on-02",
  });

  const response = await tool.handler({
    operation: "logs.query",
    parameters: {
      workspaceResourceId: validWorkspaceResourceId(),
      query: "Heartbeat | take 1",
      timespan: "PT1H",
    },
  });

  assert.equal(response.status, "ok");
  assert.equal(response.mode, "recorded");
  assert.equal(response.data.secret, undefined);
  assert.equal(response.receipt.path.endsWith(".json"), true);
  const receipts = await listReceiptPayloads(evidenceRoot, "always-on-02");
  assert.equal(receipts.some((entry) => entry.sourceCapture?.path === "captures/logs-heartbeat.json"), true);
});

test("createObservationTool blocks out-of-scope requests before transport", async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-scope-"));
  let transportCalls = 0;
  const tool = createObservationTool(
    {
      mode: "live-readonly",
      scope: SCOPE,
      captureSet: buildCaptureSet("always-on-03"),
      evidenceRoot,
      validationId: "live-1",
      caseId: "always-on-03",
    },
    {
      processRunner: async () => {
        transportCalls += 1;
        return { stdout: "{}", stderr: "", exitCode: 0 };
      },
    }
  );

  const result = await tool.handler({
    operation: "logs.query",
    parameters: {
      workspaceResourceId:
        "/subscriptions/6fc552c5-06b6-43d7-ac70-2f1eda1be033/resourceGroups/rg-foreign/providers/Microsoft.OperationalInsights/workspaces/ws-bad",
      query: "Heartbeat | take 1",
      timespan: "PT1H",
    },
  });

  test("createObservationTool persists attempt WAL before policy denial", async () => {
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-attempt-"));
    const tool = createObservationTool({
      mode: "recorded",
      scope: SCOPE,
      captureSet: buildCaptureSet("always-on-01"),
      evidenceRoot,
      validationId: null,
      caseId: "always-on-01",
    });
    const denied = await tool.handler({
      operation: "not.allowed",
      parameters: {},
    });
    assert.equal(denied.status, "denied");
    const receipts = await listReceiptPayloads(evidenceRoot, "always-on-01");
    assert.equal(receipts.some((entry) => entry.response?.phase === "attempted"), true);
    assert.equal(receipts.some((entry) => entry.status === "denied"), true);
  });

  assert.equal(result.status, "denied");
  assert.equal(result.error.kind, "policy");
  assert.equal(transportCalls, 0);
});

for (const [label, livePayload, expectedCode] of [
  [
    "evil nextLink host",
    {
      status: "ok",
      data: { rows: [{ id: 1 }] },
      nextLink: "https://evil.example/subscriptions/6fc552c5-06b6-43d7-ac70-2f1eda1be033/resourceGroups/rg-alwaysonn-global/providers/microsoft.insights/metrics?api-version=2023-10-01",
    },
    "next_link_host",
  ],
  [
    "encoded traversal in nextLink path",
    {
      status: "ok",
      data: { rows: [{ id: 1 }] },
      nextLink:
        "https://management.azure.com/subscriptions/6fc552c5-06b6-43d7-ac70-2f1eda1be033/resourceGroups/rg-alwaysonn-global/%2e%2e/providers/Microsoft.AlertsManagement/prometheusAccounts/prom-01/query?api-version=2023-04-01",
    },
    "next_link_scope",
  ],
]) {
  test(`createObservationTool rejects ${label}`, async () => {
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-next-"));
    const tool = createObservationTool(
      {
        mode: "live-readonly",
        scope: SCOPE,
        captureSet: buildCaptureSet("always-on-05"),
        evidenceRoot,
        validationId: "live-2",
        caseId: "always-on-05",
      },
      {
        processRunner: async () => ({
          stdout: JSON.stringify(livePayload),
          stderr: "",
          exitCode: 0,
        }),
      }
    );

    const result = await tool.handler({
      operation: "prom.query",
      parameters: {
        accountResourceId: validPromAccountResourceId(),
        query: "up",
        time: "2026-10-18T08:00:00Z",
      },
    });

    assert.equal(result.status, "denied");
    assert.equal(result.error.kind, "policy");
    assert.equal(result.error.code, expectedCode);
  });
}

test("createObservationTool redacts secret fields and classifies abort as infrastructure", async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-live-"));
  const redactionTool = createObservationTool(
    {
      mode: "live-readonly",
      scope: SCOPE,
      captureSet: buildCaptureSet("always-on-01"),
      evidenceRoot,
      validationId: "live-3",
      caseId: "always-on-01",
    },
    {
      processRunner: async () => ({
        stdout: JSON.stringify({
          status: "ok",
          data: { rows: [{ id: 1 }], secretToken: "x", nested: { kubeconfig: "abc", ok: true } },
        }),
        stderr: "",
        exitCode: 0,
      }),
    }
  );
  const redacted = await redactionTool.handler({
    operation: "logs.query",
    parameters: {
      workspaceResourceId: validWorkspaceResourceId(),
      query: "Heartbeat | take 1",
      timespan: "PT1H",
    },
  });
  assert.equal(redacted.status, "ok");
  assert.equal(redacted.data.secretToken, undefined);
  assert.equal(redacted.data.nested.kubeconfig, undefined);
  assert.equal(redacted.data.nested.ok, true);

  const abortTool = createObservationTool(
    {
      mode: "live-readonly",
      scope: SCOPE,
      captureSet: buildCaptureSet("always-on-01"),
      evidenceRoot,
      validationId: "live-3",
      caseId: "always-on-01",
    },
    {
      processRunner: async () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      },
    }
  );
  const aborted = await abortTool.handler({
    operation: "logs.query",
    parameters: {
      workspaceResourceId: validWorkspaceResourceId(),
      query: "Heartbeat | take 1",
      timespan: "PT1H",
    },
  });
  assert.equal(aborted.status, "error");
  assert.equal(aborted.error.kind, "infrastructure");
  assert.equal(aborted.error.code, "cancelled");
});

test("createObservationTool prom.query uses trusted endpoint and explicit prometheus resource", async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-prom-args-"));
  let seenArgs = null;
  const tool = createObservationTool(
    {
      mode: "live-readonly",
      scope: SCOPE,
      captureSet: buildCaptureSet("always-on-01"),
      evidenceRoot,
      validationId: "live-prom-1",
      caseId: "always-on-01",
    },
    {
      processRunner: async (_command, args) => {
        seenArgs = args;
        return {
          stdout: JSON.stringify({ status: "ok", data: { rows: [] } }),
          stderr: "",
          exitCode: 0,
        };
      },
    }
  );

  const result = await tool.handler({
    operation: "prom.query",
    parameters: {
      accountResourceId: validPromAccountResourceId(),
      query: "up",
      time: "2026-10-18T08:00:00Z",
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(Array.isArray(seenArgs), true);
  assert.equal(seenArgs.includes("--resource"), true);
  assert.equal(seenArgs.includes("https://prometheus.monitor.azure.com"), true);
  const urlIndex = seenArgs.indexOf("--url");
  assert.equal(urlIndex >= 0, true);
  assert.equal(
    String(seenArgs[urlIndex + 1]).startsWith(
      "https://amw-alwaysonn-swedencentral-gqd8h0ctg5cjajej.swedencentral.prometheus.monitor.azure.com/api/v1/query?"
    ),
    true
  );
});

test("createObservationTool resolves prom endpoint from matched host account capture result fields", async () => {
  const preparedRoot =
    "/Users/abossard/.copilot/session-state/9ca613bb-5687-4184-abb0-6e50c94ddc4a/files/evals/c3/units/D/prepared-capture-set/files";
  const hostCapture = await readFile(path.join(preparedRoot, "always-on-02-prometheus-host-schema-account-get.json"), "utf8");
  const routeProof = await readFile(path.join(preparedRoot, "always-on-02-prometheus-host-schema-route-proof.json"), "utf8");
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-prom-real-host-"));
  let seenArgs = null;
  const captureSet = buildCaptureSet("always-on-02");
  captureSet.entries.push({
    path: "host/prom-account-get.json",
    sha256: sha256(hostCapture),
    kind: "schema",
    visibility: "host",
    caseIds: ["always-on-02"],
    content: hostCapture,
  });
  captureSet.entries.push({
    path: "captures/prom-route-proof.json",
    sha256: sha256(routeProof),
    kind: "capture",
    visibility: "agent",
    caseIds: ["always-on-02"],
    content: routeProof,
  });
  const tool = createObservationTool(
    {
      mode: "live-readonly",
      scope: SCOPE,
      captureSet,
      evidenceRoot,
      validationId: "live-prom-real",
      caseId: "always-on-02",
    },
    {
      processRunner: async (_command, args) => {
        seenArgs = args;
        return {
          stdout: JSON.stringify({ status: "ok", data: { rows: [] } }),
          stderr: "",
          exitCode: 0,
        };
      },
    }
  );
  const result = await tool.handler({
    operation: "prom.query",
    parameters: {
      accountResourceId: validPromAccountResourceId(),
      query: "sum(healthmodel_entity_unhealthy_total)",
      time: "2026-10-18T08:41:46Z",
    },
  });
  assert.equal(result.status, "ok");
  const urlIndex = seenArgs.indexOf("--url");
  assert.equal(urlIndex >= 0, true);
  assert.equal(
    String(seenArgs[urlIndex + 1]).startsWith(
      "https://amw-alwaysonn-swedencentral-gqd8h0ctg5cjajej.swedencentral.prometheus.monitor.azure.com/api/v1/query?"
    ),
    true
  );
});

test("createObservationTool maps native Prometheus success envelope to ok", async () => {
  const preparedRoot =
    "/Users/abossard/.copilot/session-state/9ca613bb-5687-4184-abb0-6e50c94ddc4a/files/evals/c3/units/D/prepared-capture-set/files";
  const hostCapture = await readFile(path.join(preparedRoot, "always-on-02-prometheus-host-schema-account-get.json"), "utf8");
  const routeProof = JSON.parse(await readFile(path.join(preparedRoot, "always-on-02-prometheus-host-schema-route-proof.json"), "utf8"));
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-prom-success-env-"));
  const captureSet = buildCaptureSet("always-on-02");
  captureSet.entries.push({
    path: "host/prom-account-get.json",
    sha256: sha256(hostCapture),
    kind: "schema",
    visibility: "host",
    caseIds: ["always-on-02"],
    content: hostCapture,
  });
  const tool = createObservationTool(
    {
      mode: "live-readonly",
      scope: SCOPE,
      captureSet,
      evidenceRoot,
      validationId: "live-prom-env-ok",
      caseId: "always-on-02",
    },
    {
      processRunner: async () => ({
        stdout: JSON.stringify({
          status: "success",
          data: routeProof.result,
        }),
        stderr: "",
        exitCode: 0,
      }),
    }
  );
  const result = await tool.handler({
    operation: "prom.query",
    parameters: {
      accountResourceId: validPromAccountResourceId(),
      query: "sum(healthmodel_entity_unhealthy_total)",
      time: "2026-10-18T08:41:46Z",
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.error, null);
  assert.equal(Array.isArray(result.data.result), true);
});

test("createObservationTool maps native Prometheus error envelope to error with errorType and message", async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-prom-error-env-"));
  const tool = createObservationTool(
    {
      mode: "live-readonly",
      scope: SCOPE,
      captureSet: buildCaptureSet("always-on-02"),
      evidenceRoot,
      validationId: "live-prom-env-error",
      caseId: "always-on-02",
    },
    {
      processRunner: async () => ({
        stdout: JSON.stringify({
          status: "error",
          errorType: "bad_data",
          error: "invalid expression",
        }),
        stderr: "",
        exitCode: 0,
      }),
    }
  );
  const result = await tool.handler({
    operation: "prom.query",
    parameters: {
      accountResourceId: validPromAccountResourceId(),
      query: "sum(",
      time: "2026-10-18T08:41:46Z",
    },
  });
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "bad_data");
  assert.equal(result.error.message, "invalid expression");
});

test("createObservationTool denies prom.query when only generic endpoint exists without matched account capture", async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-prom-generic-deny-"));
  const captureSet = {
    suiteId: "always-on-five-v1",
    entries: [
      {
        path: "host/generic.json",
        sha256: sha256("{\"promQueryEndpoint\":\"https://prometheus.platform.example.internal\"}\n"),
        kind: "schema",
        visibility: "host",
        caseIds: ["always-on-02"],
        content: "{\"promQueryEndpoint\":\"https://prometheus.platform.example.internal\"}\n",
      },
    ],
  };
  const tool = createObservationTool(
    {
      mode: "live-readonly",
      scope: SCOPE,
      captureSet,
      evidenceRoot,
      validationId: "live-prom-deny",
      caseId: "always-on-02",
    },
    {
      processRunner: async () => ({
        stdout: JSON.stringify({ status: "ok", data: { rows: [] } }),
        stderr: "",
        exitCode: 0,
      }),
    }
  );

  const result = await tool.handler({
    operation: "prom.query",
    parameters: {
      accountResourceId: validPromAccountResourceId(),
      query: "up",
      time: "2026-10-18T08:00:00Z",
    },
  });
  assert.equal(result.status, "denied");
  assert.equal(result.error.code, "prom_endpoint_missing");
});

test("createObservationTool resource-graph injects scope predicate and preserves aggregate rows", async () => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rg-"));
  let seenArgs = null;
  const tool = createObservationTool(
    {
      mode: "live-readonly",
      scope: SCOPE,
      captureSet: buildCaptureSet("always-on-03"),
      evidenceRoot,
      validationId: "live-rg-1",
      caseId: "always-on-03",
    },
    {
      processRunner: async (_command, args) => {
        seenArgs = args;
        return {
          stdout: JSON.stringify({
            status: "ok",
            data: [{ type: "microsoft.compute/virtualmachines", total: 3 }],
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    }
  );

  const result = await tool.handler({
    operation: "resource-graph.query",
    parameters: {
      query: "resources | summarize total=count() by type",
      resourceGroups: ["RG-ALWAYSONN-GLOBAL"],
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(Array.isArray(result.data), true);
  assert.equal(result.data.length, 1);
  const qIndex = seenArgs.indexOf("-q");
  assert.equal(qIndex >= 0, true);
  const scopedQuery = String(seenArgs[qIndex + 1]);
  assert.equal(scopedQuery.includes("subscriptionId =~ '6fc552c5-06b6-43d7-ac70-2f1eda1be033'"), true);
  assert.equal(scopedQuery.includes("resourceGroup in~ ('RG-ALWAYSONN-GLOBAL')"), true);
});

test("createRehearsalTool inspect returns file digests and execute persists pre-decision attempt", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rehearsal-workspace-"));
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rehearsal-evidence-"));

  const approvedDir = path.join(workspaceRoot, "approved-package");
  const changedDir = path.join(workspaceRoot, "changed-package");
  await mkdir(approvedDir, { recursive: true });
  await mkdir(changedDir, { recursive: true });
  const packageJson = JSON.stringify({ targets: ["darkux-66"], operations: ["prom.query"] }, null, 2);
  const parametersJson = JSON.stringify({ env: "test" }, null, 2);
  await writeFile(path.join(approvedDir, "package.json"), `${packageJson}\n`, "utf8");
  await writeFile(path.join(approvedDir, "parameters.json"), `${parametersJson}\n`, "utf8");
  await writeFile(path.join(changedDir, "package.json"), `${JSON.stringify({ targets: ["darkux-67"], operations: ["prom.query"] }, null, 2)}\n`, "utf8");
  await writeFile(path.join(changedDir, "parameters.json"), `${parametersJson}\n`, "utf8");
  await writeFile(path.join(changedDir, "extra.txt"), "changed\n", "utf8");

  const tool = createRehearsalTool({
    captureSet: buildCaptureSet("always-on-04"),
    workspaceRoot,
    evidenceRoot,
    caseId: "always-on-04",
    validationId: "live-4",
  });

  const inspected = await tool.handler({ action: "inspect", packagePath: "approved-package" });
  assert.equal(inspected.status, "ok");
  assert.equal(Array.isArray(inspected.data.files), true);
  assert.equal(inspected.data.files.length >= 2, true);
  assert.equal(typeof inspected.data.contentSha256, "string");

  const denied = await tool.handler({
    action: "execute",
    packagePath: "changed-package",
    operation: "prom.query",
    claimedTargets: ["darkux-67"],
  });
  assert.equal(denied.status, "denied");
  assert.equal(denied.error.code, "approval_denied");

  const receipts = await listReceiptPayloads(evidenceRoot, "always-on-04");
  assert.equal(receipts.some((entry) => entry.operation === "rehearsal.execute" && entry.response?.phase === "attempted"), true);
  assert.equal(receipts.some((entry) => entry.operation === "rehearsal.execute" && entry.status === "denied"), true);
});

test("createRehearsalTool enforces review-approved targets and package hash", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rehearsal-gate-workspace-"));
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rehearsal-gate-evidence-"));
  const approvedDir = path.join(workspaceRoot, "approved-package");
  await mkdir(approvedDir, { recursive: true });
  const packageJson = JSON.stringify({ targets: ["darkux-66", "darkux-67"], operations: ["prom.query"] }, null, 2);
  const parametersJson = JSON.stringify({ env: "test" }, null, 2);
  await writeFile(path.join(approvedDir, "package.json"), `${packageJson}\n`, "utf8");
  await writeFile(path.join(approvedDir, "parameters.json"), `${parametersJson}\n`, "utf8");
  await writeFile(path.join(approvedDir, "material-recorded-ops.json"), "{\"ok\":true}\n", "utf8");

  const captureSet = buildCaptureSet("always-on-04");
  const tool = createRehearsalTool({
    captureSet,
    workspaceRoot,
    evidenceRoot,
    caseId: "always-on-04",
    validationId: "live-5",
  });

  const inspected = await tool.handler({ action: "inspect", packagePath: "approved-package" });
  const oracleEntry = captureSet.entries.find((entry) => entry.path === "host/approval-oracle.json");
  const oraclePayload = JSON.parse(oracleEntry.content);
  oraclePayload.approvedContentSha256 = inspected.data.contentSha256;
  oracleEntry.content = `${JSON.stringify(oraclePayload, null, 2)}\n`;
  oracleEntry.sha256 = sha256(oracleEntry.content);

  const targetDenied = await tool.handler({
    action: "execute",
    packagePath: "approved-package",
    operation: "prom.query",
    claimedTargets: ["darkux-68"],
  });
  assert.equal(targetDenied.status, "denied");
  assert.equal(targetDenied.error.code, "target_not_approved");
  oraclePayload.approvedContentSha256 = "0".repeat(64);
  oracleEntry.content = `${JSON.stringify(oraclePayload, null, 2)}\n`;
  oracleEntry.sha256 = sha256(oracleEntry.content);

  const hashDenied = await tool.handler({
    action: "execute",
    packagePath: "approved-package",
    operation: "prom.query",
    claimedTargets: ["darkux-66"],
  });
  assert.equal(inspected.status, "ok");
  assert.equal(hashDenied.status, "denied");
  assert.equal(hashDenied.error.code, "package_hash_mismatch");
});

test("createRehearsalTool fails closed when approval digest missing and when inspected sets drift", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rehearsal-strict-workspace-"));
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rehearsal-strict-evidence-"));
  const approvedDir = path.join(workspaceRoot, "approved-package");
  await mkdir(approvedDir, { recursive: true });
  const packageJson = JSON.stringify({ targets: ["darkux-66"], operations: ["prom.query"] }, null, 2);
  await writeFile(path.join(approvedDir, "package.json"), `${packageJson}\n`, "utf8");
  await writeFile(path.join(approvedDir, "parameters.json"), "{\"env\":\"test\"}\n", "utf8");

  const captureSet = buildCaptureSet("always-on-04");
  const oracleEntry = captureSet.entries.find((entry) => entry.path === "host/approval-oracle.json");
  const oraclePayload = JSON.parse(oracleEntry.content);
  delete oraclePayload.approvedContentSha256;
  oracleEntry.content = `${JSON.stringify(oraclePayload, null, 2)}\n`;
  oracleEntry.sha256 = sha256(oracleEntry.content);

  const tool = createRehearsalTool({
    captureSet,
    workspaceRoot,
    evidenceRoot,
    caseId: "always-on-04",
    validationId: "live-6",
  });

  const missingDigest = await tool.handler({
    action: "execute",
    packagePath: "approved-package",
    operation: "prom.query",
    claimedTargets: ["darkux-66"],
  });
  assert.equal(missingDigest.status, "error");
  assert.equal(missingDigest.error.code, "oracle_invalid");

  const captureSet2 = buildCaptureSet("always-on-04");
  const reviewEntry2 = captureSet2.entries.find(
    (entry) => entry.path === "reviews/always-on-04-darkux-benchmark-rehearsal-review.json"
  );
  const reviewPayload2 = JSON.parse(reviewEntry2.content);
  reviewPayload2.approvedTargets = ["darkux-66", "darkux-77"];
  reviewEntry2.content = `${JSON.stringify(reviewPayload2, null, 2)}\n`;
  reviewEntry2.sha256 = sha256(reviewEntry2.content);

  const tool2 = createRehearsalTool({
    captureSet: captureSet2,
    workspaceRoot,
    evidenceRoot,
    caseId: "always-on-04",
    validationId: "live-7",
  });
  const inspected = await tool2.handler({ action: "inspect", packagePath: "approved-package" });
  const oracleEntry2 = captureSet2.entries.find((entry) => entry.path === "host/approval-oracle.json");
  const oraclePayload2 = JSON.parse(oracleEntry2.content);
  oraclePayload2.approvedContentSha256 = inspected.data.contentSha256;
  oracleEntry2.content = `${JSON.stringify(oraclePayload2, null, 2)}\n`;
  oracleEntry2.sha256 = sha256(oracleEntry2.content);

  const driftDenied = await tool2.handler({
    action: "execute",
    packagePath: "approved-package",
    operation: "prom.query",
    claimedTargets: ["darkux-66"],
  });
  assert.equal(driftDenied.status, "denied");
  assert.equal(driftDenied.error.code, "target_set_not_approved");
});

test("createRehearsalTool returns matched recorded readbacks for approved execute", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rehearsal-readback-workspace-"));
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rehearsal-readback-evidence-"));
  const approvedDir = path.join(workspaceRoot, "approved-package");
  await mkdir(approvedDir, { recursive: true });
  await writeFile(
    path.join(approvedDir, "package.json"),
    `${JSON.stringify({ targets: ["darkux-66", "darkux-67"], operations: ["prom.query"] }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(path.join(approvedDir, "parameters.json"), "{\"env\":\"test\"}\n", "utf8");

  const captureSet = buildCaptureSet("always-on-04");
  const readbackPayload = {
    operation: "prom.query",
    request: { operation: "prom.query", target: "darkux-66" },
    target: "darkux-66",
    result: { rows: [{ id: "darkux-66", status: "recorded" }] },
  };
  const readbackContent = `${JSON.stringify(readbackPayload, null, 2)}\n`;
  captureSet.entries.push({
    path: "captures/darkux-prom-readback.json",
    sha256: sha256(readbackContent),
    kind: "capture",
    visibility: "agent",
    caseIds: ["always-on-04"],
    content: readbackContent,
  });

  const tool = createRehearsalTool({
    captureSet,
    workspaceRoot,
    evidenceRoot,
    caseId: "always-on-04",
    validationId: "live-8",
  });
  const inspected = await tool.handler({ action: "inspect", packagePath: "approved-package" });
  const oracleEntry = captureSet.entries.find((entry) => entry.path === "host/approval-oracle.json");
  const oraclePayload = JSON.parse(oracleEntry.content);
  oraclePayload.approvedContentSha256 = inspected.data.contentSha256;
  oracleEntry.content = `${JSON.stringify(oraclePayload, null, 2)}\n`;
  oracleEntry.sha256 = sha256(oracleEntry.content);

  const executed = await tool.handler({
    action: "execute",
    packagePath: "approved-package",
    operation: "prom.query",
    claimedTargets: ["darkux-66", "darkux-67"],
  });
  assert.equal(executed.status, "ok");
  assert.equal(Array.isArray(executed.data.readbacks), true);
  assert.equal(executed.data.readbacks.length >= 1, true);
  assert.equal(executed.data.matchedCaptureRefs.some((entry) => entry.path === "captures/darkux-prom-readback.json"), true);
});

test("createRehearsalTool excludes non-agent visibility readbacks", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rehearsal-visibility-workspace-"));
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "az-ro-rehearsal-visibility-evidence-"));
  const approvedDir = path.join(workspaceRoot, "approved-package");
  await mkdir(approvedDir, { recursive: true });
  await writeFile(
    path.join(approvedDir, "package.json"),
    `${JSON.stringify({ targets: ["darkux-66", "darkux-67"], operations: ["prom.query"] }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(path.join(approvedDir, "parameters.json"), "{\"env\":\"test\"}\n", "utf8");

  const captureSet = buildCaptureSet("always-on-04");
  const hostReadback = {
    operation: "prom.query",
    request: { operation: "prom.query", target: "darkux-66" },
    target: "darkux-66",
    result: { rows: [{ id: "darkux-66", status: "host-only" }] },
  };
  const hostContent = `${JSON.stringify(hostReadback, null, 2)}\n`;
  captureSet.entries.push({
    path: "captures/darkux-prom-readback-host.json",
    sha256: sha256(hostContent),
    kind: "capture",
    visibility: "host",
    caseIds: ["always-on-04"],
    content: hostContent,
  });

  const tool = createRehearsalTool({
    captureSet,
    workspaceRoot,
    evidenceRoot,
    caseId: "always-on-04",
    validationId: "live-9",
  });
  const inspected = await tool.handler({ action: "inspect", packagePath: "approved-package" });
  const oracleEntry = captureSet.entries.find((entry) => entry.path === "host/approval-oracle.json");
  const oraclePayload = JSON.parse(oracleEntry.content);
  oraclePayload.approvedContentSha256 = inspected.data.contentSha256;
  oracleEntry.content = `${JSON.stringify(oraclePayload, null, 2)}\n`;
  oracleEntry.sha256 = sha256(oracleEntry.content);

  const executed = await tool.handler({
    action: "execute",
    packagePath: "approved-package",
    operation: "prom.query",
    claimedTargets: ["darkux-66", "darkux-67"],
  });
  assert.equal(executed.status, "empty");
  assert.equal(
    executed.data.matchedCaptureRefs.some((entry) => entry.path === "captures/darkux-prom-readback-host.json"),
    false
  );
});
