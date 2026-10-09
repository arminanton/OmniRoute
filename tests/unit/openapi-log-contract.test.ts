import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const root = process.cwd();
const docsSpecText = fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8");
const publicSpecText = fs.readFileSync(path.join(root, "public/openapi.yaml"), "utf8");
const spec = yaml.load(docsSpecText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const logExportSource = fs.readFileSync(
  path.join(root, "src/app/api/logs/export/route.ts"),
  "utf8"
);
const proxyLogsRouteSource = fs.readFileSync(
  path.join(root, "src/app/api/usage/proxy-logs/route.ts"),
  "utf8"
);
const proxyLoggerSource = fs.readFileSync(path.join(root, "src/lib/proxyLogger.ts"), "utf8");
const managementPolicySource = fs.readFileSync(
  path.join(root, "src/server/authz/policies/management.ts"),
  "utf8"
);

function allowsAnonymous(operation: Record<string, any>): boolean {
  return operation.security?.some(
    (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
  );
}

test("log API contracts describe source-backed sensitivity and conditional management auth", () => {
  assert.equal(publicSpecText, docsSpecText, "public/openapi.yaml must match docs/openapi.yaml");

  assert.match(logExportSource, /exportCallLogsSince\(since\)/);
  assert.match(logExportSource, /exportProxyLogsSince\(since\)/);
  assert.match(logExportSource, /JSON\.stringify\(\{ logs: rows, count: rows\.length/);

  const logExport = spec.paths["/api/logs/export"].get;
  assert.equal(logExport.responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.LogExportResponse["x-sensitive"], true);
  assert.equal(spec.components.schemas.LogExportRow["x-sensitive"], true);
  assert.match(logExport.description, /prompts and responses/i);
  assert.match(spec.components.schemas.LogExportRow.description, /client and egress IPs/i);

  assert.match(proxyLogsRouteSource, /getProxyLogs\(filters\)/);
  assert.match(proxyLogsRouteSource, /clearProxyLogs\(\)/);
  assert.match(proxyLoggerSource, /clientIp: string \| null/);
  assert.match(proxyLoggerSource, /egressIp: string \| null/);
  assert.match(proxyLoggerSource, /DELETE FROM proxy_logs/);

  const proxyLogs = spec.paths["/api/usage/proxy-logs"];
  for (const method of ["get", "delete"]) {
    const operation = proxyLogs[method];
    assert.ok(operation, `missing ${method.toUpperCase()} /api/usage/proxy-logs`);
    assert.ok(allowsAnonymous(operation), `${method.toUpperCase()} documents requireLogin=false`);
    assert.ok(operation.security.some((entry: object) => Object.hasOwn(entry, "BearerAuth")));
    assert.ok(
      operation.security.some((entry: object) => Object.hasOwn(entry, "ManagementSessionAuth"))
    );
    assert.ok(operation.responses["401"]);
    assert.ok(operation.responses["403"]);
    assert.ok(operation.responses["503"]);
    assert.match(operation.description, /locked management authentication/i);
    assert.match(operation.description, /requireLogin=false[\s\S]*anonymous access/i);
  }

  assert.equal(proxyLogs.get.responses["200"]["x-sensitive"], true);
  assert.match(proxyLogs.delete.description, /attempts to delete persisted `proxy_logs` rows/i);
  assert.match(proxyLogs.delete.description, /cleanup failure is logged/i);
  assert.match(managementPolicySource, /!isAlwaysProtectedPath\(path\)[\s\S]*?auth-disabled/);
});
