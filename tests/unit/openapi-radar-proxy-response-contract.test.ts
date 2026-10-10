import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as yaml from "js-yaml";

const canonicalText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

function operation(method: string, pathname: string) {
  const value = spec.paths[pathname]?.[method];
  assert.ok(value, `Missing ${method.toUpperCase()} ${pathname}`);
  return value;
}

const contracts = [
  ["post", "/api/proxy-fallback/test", ["200", "400", "401", "403", "500", "503"], "ProxyFallbackTestResponse"],
  ["get", "/api/radar/catalog", ["200", "401", "403", "404", "500", "503"], "RadarCatalogResponse"],
  ["get", "/api/radar/intel", ["200", "401", "403", "404", "500", "503"], "RadarIntelResponse"],
  ["post", "/api/radar/intel/sync", ["200", "400", "401", "403", "404", "413", "500", "503"], "RadarIntelSyncStatus"],
  ["delete", "/api/radar/local-model-state", ["200", "400", "401", "403", "404", "500", "503"], "RadarLocalModelStateResponse"],
  ["get", "/api/radar/local-model-state", ["200", "401", "403", "404", "500", "503"], "RadarLocalModelStateResponse"],
  ["patch", "/api/radar/local-model-state", ["200", "400", "401", "403", "404", "413", "500", "503"], "RadarLocalModelStateResponse"],
  ["put", "/api/radar/local-model-state", ["200", "400", "401", "403", "404", "413", "500", "503"], "RadarLocalModelStateResponse"],
  ["get", "/api/radar/offers", ["200", "401", "403", "404", "500", "503"], "RadarOffersResponse"],
  ["post", "/api/radar/offers/sync", ["200", "400", "401", "403", "404", "413", "500", "503"], "RadarOffersSyncStatus"],
  ["get", "/api/radar/referrals", ["200", "401", "403", "404", "500", "503"], "RadarReferralsResponse"],
  ["get", "/api/radar/settings", ["200", "401", "403", "404", "500", "503"], "RadarSettingsGetResponse"],
  ["post", "/api/radar/settings", ["200", "400", "401", "403", "404", "500", "503"], "RadarSettingsPostResponse"],
  ["get", "/api/radar/status", ["200", "401", "403", "404", "500", "503"], "RadarStatusResponse"],
  ["post", "/api/radar/sync", ["200", "400", "401", "403", "404", "413", "500", "503"], "RadarSyncStatus"],
] as const;

test("the 15 Radar/proxy operations have source-backed status sets and typed successes", () => {
  assert.equal(contracts.length, 15);
  for (const [method, pathname, statuses, schemaName] of contracts) {
    const op = operation(method, pathname);
    assert.deepEqual(Object.keys(op.responses).sort(), [...statuses].sort(), `${method.toUpperCase()} ${pathname}`);
    const schema = op.responses["200"].content?.["application/json"]?.schema;
    assert.equal(schema?.$ref, `#/components/schemas/${schemaName}`, `${method.toUpperCase()} ${pathname}`);
    assert.ok(spec.components.schemas[schemaName!], `Missing ${schemaName}`);
  }
});

test("Radar management scopes and non-local routing declarations are preserved", () => {
  const secured = [
    ["post", "/api/proxy-fallback/test"],
    ["get", "/api/radar/catalog"],
    ["get", "/api/radar/intel"],
    ["post", "/api/radar/intel/sync"],
    ["delete", "/api/radar/local-model-state"],
    ["get", "/api/radar/local-model-state"],
    ["patch", "/api/radar/local-model-state"],
    ["put", "/api/radar/local-model-state"],
    ["get", "/api/radar/offers"],
    ["post", "/api/radar/offers/sync"],
    ["get", "/api/radar/referrals"],
    ["get", "/api/radar/settings"],
  ] as const;
  for (const [method, pathname] of secured) {
    assert.equal(operation(method, pathname).security.length, 7, `${method.toUpperCase()} ${pathname}`);
    assert.equal(operation(method, pathname)["x-local-only"], undefined);
  }
  for (const [method, pathname] of [["post", "/api/radar/settings"], ["get", "/api/radar/status"], ["post", "/api/radar/sync"]]) {
    assert.equal(operation(method, pathname).security.length, 7, `${method.toUpperCase()} ${pathname} retains management auth`);
    assert.equal(operation(method, pathname)["x-local-only"], undefined);
  }
});

test("proxy credentials, supporter settings, referrals, and Radar data are marked sensitive", () => {
  const proxy = operation("post", "/api/proxy-fallback/test");
  assert.equal(proxy.requestBody["x-sensitive"], true);
  assert.equal(proxy.responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.ProxyFallbackTestResult.properties.proxyUrl["x-sensitive"], true);
  assert.equal(operation("post", "/api/radar/settings").requestBody["x-sensitive"], true);
  assert.equal(spec.components.schemas.RadarSettingsUpdateRequest.properties.supporterKey["x-sensitive"], true);
  assert.equal(spec.components.schemas.RadarSettingsGetResponse.properties.supporterKeyMasked["x-sensitive"], true);
  assert.equal(spec.components.schemas.RadarReferral.properties.url["x-sensitive"], true);
  assert.equal(operation("get", "/api/radar/intel").responses["200"]["x-sensitive"], true);
  assert.equal(operation("get", "/api/radar/offers").responses["200"]["x-sensitive"], true);
  assert.equal(operation("get", "/api/radar/status").responses["200"]["x-sensitive"], true);
});

test("feature-off errors, bounded bodies, no-store conditions, and masked-key caching are exact", () => {
  assert.equal(operation("get", "/api/radar/catalog").responses["404"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(operation("get", "/api/radar/catalog").responses["200"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(operation("get", "/api/radar/catalog").responses["500"].headers, undefined);
  assert.equal(operation("get", "/api/radar/intel").responses["200"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(operation("get", "/api/radar/intel").responses["404"].headers, undefined);

  for (const method of ["delete", "get", "patch", "put"]) {
    const local = operation(method, "/api/radar/local-model-state");
    for (const status of ["200", "400", "404", "413", "500"]) {
      if (local.responses[status]) assert.equal(local.responses[status].headers["Cache-Control"].schema.const, "no-store");
    }
  }

  const getSettings = operation("get", "/api/radar/settings");
  const postSettings = operation("post", "/api/radar/settings");
  assert.equal(getSettings.responses["200"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(getSettings.responses["404"].headers["Cache-Control"].schema.const, "no-store");
  for (const status of ["200", "400", "404", "500"]) {
    assert.equal(postSettings.responses[status].headers["Cache-Control"].schema.const, "no-store");
  }
  assert.equal(postSettings.responses["401"].headers, undefined);
  assert.equal(postSettings.responses["403"].headers, undefined);

  for (const pathname of ["/api/radar/intel/sync", "/api/radar/offers/sync", "/api/radar/sync"]) {
    const op = operation("post", pathname);
    assert.equal(op.requestBody.required, false);
    assert.equal(op.requestBody.content["application/json"].schema.$ref, "#/components/schemas/RadarSyncBodyRequest");
  }
});

test("sync status unions, feed/meta variants, and local state shape are represented", () => {
  assert.equal(spec.components.schemas.RadarCatalogResponse.properties.meta.oneOf[1].type, "null");
  assert.equal(spec.components.schemas.RadarIntelResponse.properties.intel.oneOf[1].type, "null");
  assert.equal(spec.components.schemas.RadarOffersResponse.properties.meta.oneOf[1].type, "null");
  assert.equal(spec.components.schemas.RadarStatusResponse.properties.feeds.required.length, 4);
  assert.ok(spec.components.schemas.RadarLocalModelState.properties.tombstoned);
  assert.ok(spec.components.schemas.RadarLocalOverridePatchRequest.anyOf);
  for (const schemaName of ["RadarSyncStatus", "RadarIntelSyncStatus", "RadarOffersSyncStatus"]) {
    const statuses = spec.components.schemas[schemaName].oneOf.map((branch: any) => branch.properties.status.const);
    assert.ok(statuses.includes("updated"), schemaName);
    assert.ok(statuses.includes("error"), schemaName);
  }
  assert.deepEqual(spec.components.schemas.RadarSettingsPostResponse.required, ["ok"]);
  assert.equal(spec.components.schemas.RadarSettingsPostResponse.properties.supporterKey["x-sensitive"], true);
});

test("public OpenAPI mirror remains byte-identical to the canonical document", () => {
  assert.equal(fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8"), canonicalText);
});
