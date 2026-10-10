import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { ACCOUNT_FALLBACK_STRATEGY_VALUES } from "../../src/shared/constants/routingStrategies.ts";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;

test("settings account-routing contracts mirror accepted source strategies", () => {
  const strategy = spec.components.schemas.AccountFallbackStrategy;
  assert.deepEqual(strategy.enum, [...ACCOUNT_FALLBACK_STRATEGY_VALUES]);
  assert.match(strategy.description, /defaults to available-capacity/i);
  assert.match(strategy.description, /does not replace the account concurrency admission gate/i);

  const get = spec.paths["/api/settings"].get;
  const patch = spec.paths["/api/settings"].patch;
  const put = spec.paths["/api/settings"].put;
  assert.equal(
    get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ApplicationSettingsReadResponse"
  );
  assert.equal(
    patch.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ApplicationSettingsUpdateRequest"
  );
  assert.equal(
    put.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ApplicationSettingsUpdateRequest"
  );

  const persisted = spec.components.schemas.ApplicationSettingsPersistedValues;
  assert.equal(
    persisted.properties.fallbackStrategy.$ref,
    "#/components/schemas/AccountFallbackStrategy"
  );
  assert.equal(
    persisted.properties.providerStrategies.additionalProperties.$ref,
    "#/components/schemas/ProviderAccountRoutingOverride"
  );
  const update = spec.components.schemas.ApplicationSettingsUpdateRequest;
  assert.equal(
    update.properties.fallbackStrategy.allOf[0].$ref,
    "#/components/schemas/AccountFallbackStrategy"
  );
  assert.equal(
    update.properties.providerStrategies.additionalProperties.$ref,
    "#/components/schemas/ProviderAccountRoutingOverride"
  );
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
