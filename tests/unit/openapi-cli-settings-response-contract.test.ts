import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as yaml from "js-yaml";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};
const canonicalSource = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");

function operation(method: string, route: string) {
  const value = spec.paths[route]?.[method];
  assert.ok(value, `Missing ${method.toUpperCase()} ${route}`);
  return value;
}

const responseContracts = [
  ["get", "/api/cli-tools/openclaw-settings", "OpenClawSettingsGetResponse", ["200", "401", "403", "500", "503"]],
  ["post", "/api/cli-tools/openclaw-settings", "OpenClawSettingsApplyResponse", ["200", "400", "401", "403", "500", "503"]],
  ["delete", "/api/cli-tools/pi-settings", "PiSettingsDeleteResponse", ["200", "401", "403", "500", "503"]],
  ["get", "/api/cli-tools/pi-settings", "PiSettingsGetResponse", ["200", "401", "403", "500", "503"]],
  ["post", "/api/cli-tools/pi-settings", "PiSettingsApplyResponse", ["200", "400", "401", "403", "500", "503"]],
  ["delete", "/api/cli-tools/qwen-settings", "QwenSettingsDeleteResponse", ["200", "401", "403", "500", "503"]],
  ["get", "/api/cli-tools/qwen-settings", "QwenSettingsGetResponse", ["200", "401", "403", "500", "503"]],
  ["post", "/api/cli-tools/qwen-settings", "QwenSettingsApplyResponse", ["200", "400", "401", "403", "500", "503"]],
  ["delete", "/api/cli-tools/smelt-settings", "SmeltSettingsDeleteResponse", ["200", "401", "403", "500", "503"]],
  ["get", "/api/cli-tools/smelt-settings", "SmeltSettingsGetResponse", ["200", "401", "403", "500", "503"]],
  ["post", "/api/cli-tools/smelt-settings", "SmeltSettingsApplyResponse", ["200", "400", "401", "403", "500", "503"]],
  ["get", "/api/cli/whoami", "CliWhoamiResponse", ["200", "401", "403", "503"]],
  ["get", "/api/codex/connect/{token}", "CodexConnectTicketResponse", ["200", "404"]],
  ["post", "/api/codex/connect/{token}", "CodexConnectCompleteResponse", ["200", "400", "410", "500"]],
  ["post", "/api/compression/compare", "CompressionCompareResponse", ["200", "400", "401", "403", "500", "503"]],
] as const;

test("the 15 audited operations document typed 200 response contracts", () => {
  assert.equal(responseContracts.length, 15);
  for (const [method, route, schemaName, expectedStatuses] of responseContracts) {
    const routeOperation = operation(method, route);
    const response = routeOperation.responses["200"];
    assert.ok(response, `${method.toUpperCase()} ${route} is missing 200`);
    assert.deepEqual(
      Object.keys(routeOperation.responses).sort(),
      [...expectedStatuses].sort(),
      `${method.toUpperCase()} ${route} status set`,
    );
    assert.equal(
      response.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${schemaName}`,
      `${method.toUpperCase()} ${route}`,
    );
    assert.ok(spec.components.schemas[schemaName], `Missing ${schemaName}`);
  }
});

test("public OpenAPI mirror stays byte-identical to the canonical document", () => {
  assert.equal(
    fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8"),
    canonicalSource,
  );
});

test("CLI settings contracts preserve credential and filesystem sensitivity", () => {
  for (const route of [
    "/api/cli-tools/openclaw-settings",
    "/api/cli-tools/pi-settings",
    "/api/cli-tools/qwen-settings",
    "/api/cli-tools/smelt-settings",
  ]) {
    const get = operation("get", route);
    assert.equal(get.responses["200"]["x-sensitive"], true, `GET ${route}`);
    if (route !== "/api/cli-tools/openclaw-settings") {
      const post = operation("post", route);
      assert.equal(post.requestBody["x-sensitive"], true, `POST ${route}`);
      assert.equal(
        post.requestBody.content["application/json"].schema.$ref,
        "#/components/schemas/CliModelConfigRequest",
      );
    }
  }
  assert.equal(
    operation("post", "/api/cli-tools/openclaw-settings").requestBody["x-sensitive"],
    true,
  );
  assert.equal(
    spec.components.schemas.CliModelConfigRequest.properties.apiKey["x-sensitive"],
    true,
  );
});

test("Codex public device-flow responses are no-store across every handled status", () => {
  const get = operation("get", "/api/codex/connect/{token}");
  const post = operation("post", "/api/codex/connect/{token}");
  assert.deepEqual(get.security, []);
  assert.equal(
    spec.paths["/api/codex/connect/{token}"].parameters?.[0]?.["x-sensitive"],
    true,
  );
  assert.equal(get.responses["200"]["x-sensitive"], true);

  for (const [route, statuses] of [
    [get, ["200", "404"]],
    [post, ["200", "400", "410", "500"]],
  ] as const) {
    for (const status of statuses) {
      assert.equal(
        route.responses[status]?.headers?.["Cache-Control"]?.schema?.const,
        "no-store",
        `Codex connect ${status}`,
      );
    }
  }
  assert.equal(post.requestBody["x-sensitive"], true);
  assert.equal(post.responses["200"]["x-sensitive"], true);
});

test("compression compare marks prompt input sensitive and returns summary rows", () => {
  const compare = operation("post", "/api/compression/compare");
  assert.equal(compare.requestBody["x-sensitive"], true);
  assert.equal(compare.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/CompressionCompareResponse");
  assert.equal(
    spec.components.schemas.CompressionCompareResponse.properties.rows.items.$ref,
    "#/components/schemas/CompressionEngineSummaryRow",
  );
});
