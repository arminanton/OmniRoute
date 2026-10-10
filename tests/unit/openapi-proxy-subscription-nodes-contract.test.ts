import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

const root = process.cwd();
const canonicalText = fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(root, "public/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as any;

test("proxy-subscription nodes expose the source-backed redacted node union", () => {
  const operation = spec.paths["/api/v1/management/proxy-subscriptions/{id}/nodes"]?.get;
  assert.ok(operation, "missing GET /api/v1/management/proxy-subscriptions/{id}/nodes");
  assert.equal(
    operation.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProxySubscriptionNodesResponse"
  );

  const response = spec.components.schemas.ProxySubscriptionNodesResponse;
  assert.deepEqual(response.required, [
    "id",
    "name",
    "mode",
    "enabled",
    "status",
    "error",
    "lastFetchedAt",
    "nodes",
  ]);
  assert.equal(
    response.properties.nodes.items.$ref,
    "#/components/schemas/ProxySubscriptionNodeSummary"
  );

  const nodeSummary = spec.components.schemas.ProxySubscriptionNodeSummary;
  assert.equal(nodeSummary.oneOf.length, 2);
  const direct = nodeSummary.oneOf.find((schema: any) => schema.properties?.hasAuth);
  const core = nodeSummary.oneOf.find((schema: any) => schema.properties?.detail);
  assert.ok(direct, "direct HTTP/HTTPS/SOCKS nodes include the redacted auth-presence flag");
  assert.ok(core, "proxy-core-only protocols expose an operator summary");
  assert.deepEqual(direct.required, ["name", "type", "host", "port", "rawProtocol", "hasAuth"]);
  assert.deepEqual(core.required, ["name", "rawProtocol", "detail"]);
  assert.equal(direct.properties.type.enum.join(","), "http,https,socks5");
  for (const shape of [direct, core]) {
    assert.equal(shape.additionalProperties, false);
    assert.equal("username" in shape.properties, false);
    assert.equal("password" in shape.properties, false);
  }

  assert.equal(
    spec.components.schemas.ProxySubscription.properties.lastNodes.items.$ref,
    "#/components/schemas/ProxySubscriptionNodeSummary"
  );
});

test("the public OpenAPI artifact matches the canonical proxy-subscription contract", () => {
  assert.equal(publicText, canonicalText);
});
