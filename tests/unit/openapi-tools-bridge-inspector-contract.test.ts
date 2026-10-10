import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { collectApiRouteDefinitions } from "../../scripts/check/lib/apiRoutes.mjs";
import { summarizeDiagnostics } from "../../src/mitm/inspector/diagnostics.ts";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = yaml.load(
  fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")
) as any;
const TARGET_PREFIXES = ["/api/tools/agent-bridge/", "/api/tools/traffic-inspector/"];

function operation(route: string, method: string): any {
  const result = spec.paths[route]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${route}`);
  return result;
}

test("AgentBridge and Traffic Inspector OpenAPI operations match source and declare their peer/auth boundary", () => {
  const source = collectApiRouteDefinitions(ROOT);
  const sourceOperations = new Set<string>();
  for (const [route, methods] of source) {
    if (!TARGET_PREFIXES.some((prefix) => route.startsWith(prefix))) continue;
    for (const method of methods) sourceOperations.add(`${method.toLowerCase()} ${route}`);
  }

  const documentedOperations = new Set<string>();
  for (const [route, item] of Object.entries(spec.paths) as Array<[string, any]>) {
    if (!TARGET_PREFIXES.some((prefix) => route.startsWith(prefix))) continue;
    for (const method of ["get", "post", "put", "patch", "delete", "head"]) {
      if (item[method]) documentedOperations.add(`${method} ${route}`);
    }
  }

  assert.equal(sourceOperations.size, 51);
  assert.deepEqual([...documentedOperations].sort(), [...sourceOperations].sort());

  for (const id of sourceOperations) {
    const [method, ...pathParts] = id.split(" ");
    const route = pathParts.join(" ");
    const op = operation(route, method);
    assert.equal(op["x-local-only"], true, `${id} must retain the route-guard tier marker`);
    assert.ok(op.responses?.["401"], `${id} must document configured management auth`);
    assert.ok(op.responses?.["403"], `${id} must document local-peer/scope rejection`);
    assert.ok(op.responses?.["503"], `${id} must document auth-backend failure`);

    const security = op.security ?? [];
    if (id === "post /api/tools/traffic-inspector/internal/ingest") {
      assert.ok(
        security.some(
          (requirement: Record<string, unknown>) =>
            "InspectorInternalIngestBearerAuth" in requirement
        )
      );
      assert.equal(
        security.some(
          (requirement: Record<string, unknown>) => Object.keys(requirement).length === 0
        ),
        false,
        "the internal ingest token route is never anonymous"
      );
    } else {
      assert.ok(
        security.some((requirement: Record<string, unknown>) => "BearerAuth" in requirement)
      );
      assert.ok(
        security.some(
          (requirement: Record<string, unknown>) => "ManagementSessionAuth" in requirement
        )
      );
      assert.ok(
        security.some(
          (requirement: Record<string, unknown>) => Object.keys(requirement).length === 0
        ),
        `${id} must reflect the ordinary requireLogin-disabled local bootstrap policy`
      );
    }
  }

  for (const tagName of ["AgentBridge", "Traffic Inspector"]) {
    const tag = spec.tags.find((candidate: any) => candidate.name === tagName);
    assert.match(tag?.description ?? "", /trusted private-network peers/i);
    assert.match(tag?.description ?? "", /requireLogin/i);
    assert.match(tag?.description ?? "", /public remote manage-scope bypass is not allowed/i);
  }
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror the canonical document");
});

test("AgentBridge certificate, wrappers, and maintenance request contracts match handlers", () => {
  const certificateTrust = operation("/api/tools/agent-bridge/cert", "post");
  assert.equal(certificateTrust.requestBody?.required, false);
  assert.equal(
    certificateTrust.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/AgentBridgeCertTrustRequest"
  );
  assert.equal(
    spec.components.schemas.AgentBridgeCertTrustRequest.properties.action,
    undefined,
    "cert POST installs trust; download/regeneration have separate routes"
  );
  assert.equal(
    certificateTrust.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/AgentBridgeCertTrustResponse"
  );
  for (const status of ["400", "404", "409", "500"])
    assert.ok(certificateTrust.responses?.[status]);

  const download = operation("/api/tools/agent-bridge/cert/download", "get").responses?.["200"];
  assert.equal(download?.content?.["application/x-pem-file"]?.schema?.format, "binary");
  assert.ok(download?.headers?.["Content-Disposition"]);

  assert.equal(
    operation("/api/tools/agent-bridge/agents", "get").responses?.["200"]?.content?.[
      "application/json"
    ]?.schema?.$ref,
    "#/components/schemas/AgentBridgeAgentListResponse"
  );
  assert.equal(
    operation("/api/tools/agent-bridge/state", "get").responses?.["200"]?.content?.[
      "application/json"
    ]?.schema?.$ref,
    "#/components/schemas/AgentBridgeStateResponse"
  );
  assert.equal(
    operation("/api/tools/agent-bridge/agents/{id}/mappings", "get").responses?.["200"]?.content?.[
      "application/json"
    ]?.schema?.$ref,
    "#/components/schemas/AgentBridgeMappingsResponse"
  );
  assert.ok(
    spec.components.schemas.AgentBridgeDetectedModelsAgentId.enum.includes("windsurf") &&
      spec.components.schemas.AgentBridgeDetectedModelsAgentId.enum.includes("jules")
  );
});

test("AgentBridge diagnose response schema matches the source diagnostic report", () => {
  const diagnose = operation("/api/tools/agent-bridge/diagnose", "get");
  assert.equal(
    diagnose.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/AgentBridgeDiagnosticsResponse"
  );

  const reportSchema = spec.components.schemas.AgentBridgeDiagnosticsResponse;
  const checkSchema = spec.components.schemas.AgentBridgeDiagnosticCheck;
  assert.deepEqual(reportSchema.required, ["healthy", "checks", "port"]);
  assert.equal(reportSchema.additionalProperties, false);
  assert.equal(reportSchema.properties.healthy.type, "boolean");
  assert.equal(reportSchema.properties.port.type, "integer");
  assert.equal(reportSchema.properties.port.minimum, 1);
  assert.equal(reportSchema.properties.port.maximum, 65535);
  assert.equal(reportSchema.properties.checks.type, "array");
  assert.equal(reportSchema.properties.checks.minItems, 5);
  assert.equal(reportSchema.properties.checks.maxItems, 5);
  assert.equal(
    reportSchema.properties.checks.items.$ref,
    "#/components/schemas/AgentBridgeDiagnosticCheck"
  );

  const actualReport = summarizeDiagnostics({
    serverRunning: false,
    serverReachable: false,
    certExists: false,
    certTrusted: false,
    dnsConfigured: false,
  });
  assert.equal(actualReport.healthy, false);
  assert.deepEqual(
    checkSchema.properties.name.enum,
    actualReport.checks.map((check) => check.name)
  );
  assert.deepEqual(checkSchema.required, ["name", "ok", "hint"]);
  assert.equal(checkSchema.additionalProperties, false);
  assert.equal(checkSchema.properties.ok.type, "boolean");
  assert.deepEqual(checkSchema.properties.hint.type, ["string", "null"]);
  assert.ok(actualReport.checks.every((check) => typeof check.hint === "string"));

  const healthyReport = summarizeDiagnostics({
    serverRunning: true,
    serverReachable: true,
    certExists: true,
    certTrusted: true,
    dnsConfigured: true,
  });
  assert.equal(healthyReport.healthy, true);
  assert.ok(healthyReport.checks.every((check) => check.hint === null));
});

test("Traffic Inspector wrappers, media, buffered replay, and nonempty success statuses match handlers", () => {
  assert.equal(
    operation("/api/tools/traffic-inspector/requests", "get").responses?.["200"]?.content?.[
      "application/json"
    ]?.schema?.$ref,
    "#/components/schemas/InspectorRequestListResponse"
  );
  assert.equal(
    operation("/api/tools/traffic-inspector/hosts", "get").responses?.["200"]?.content?.[
      "application/json"
    ]?.schema?.$ref,
    "#/components/schemas/InspectorHostListResponse"
  );
  assert.equal(
    operation("/api/tools/traffic-inspector/sessions", "get").responses?.["200"]?.content?.[
      "application/json"
    ]?.schema?.$ref,
    "#/components/schemas/InspectorSessionListResponse"
  );
  assert.ok(spec.components.schemas.CaptureSource.enum.includes("tproxy"));
  assert.ok(spec.components.schemas.InspectorCaptureModesState.properties.tlsIntercept);

  const proxy = operation("/api/tools/traffic-inspector/capture-modes/http-proxy", "post");
  assert.ok(proxy.responses?.["201"], "first HTTP listener start returns 201");
  assert.ok(proxy.responses?.["409"]);

  const append = operation("/api/tools/traffic-inspector/sessions/{id}/requests", "post");
  assert.equal(
    append.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/InspectorSessionRequestAppendResponse"
  );
  assert.equal(
    append.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/InspectorSessionRequestAppend"
  );

  const replay = operation("/api/tools/traffic-inspector/requests/{id}/replay", "post");
  assert.ok(replay.responses?.default?.content?.["*/*"]?.schema);
  assert.ok(replay.responses?.["502"]);
  assert.match(replay.description ?? "", /captured HTTP method, path, and stored request body/i);
  assert.match(replay.description ?? "", /forwards it/i);
  assert.match(replay.description ?? "", /buffered as text rather than streamed/i);

  const exportHar = operation("/api/tools/traffic-inspector/export.har", "get").responses?.["200"];
  assert.ok(exportHar?.headers?.["Content-Disposition"]);
  assert.equal(exportHar?.headers?.["Cache-Control"]?.schema?.const, "no-store");
  const hostDelete = operation("/api/tools/traffic-inspector/hosts/{host}", "delete").responses?.[
    "204"
  ];
  assert.ok(hostDelete?.headers?.["x-dns-warning"]);
});

test("internal ingest uses its dedicated Bearer token and source status codes", () => {
  const ingest = operation("/api/tools/traffic-inspector/internal/ingest", "post");
  assert.equal(ingest.responses?.["200"]?.content?.["application/json"]?.schema?.type, "object");
  assert.ok(ingest.responses?.["400"]);
  assert.ok(ingest.responses?.["403"]);
  assert.ok(ingest.responses?.["500"]);
  assert.equal(ingest.responses?.["204"], undefined);
  assert.match(ingest.description ?? "", /INSPECTOR_INTERNAL_INGEST_TOKEN/);
  assert.match(ingest.description ?? "", /locked.management mode.*explicit environment token/i);
});
