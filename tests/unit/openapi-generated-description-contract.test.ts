import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";
import { OPENAPI_ENDPOINTS } from "../../src/app/docs/lib/openapi.generated.ts";

const spec = yaml.load(
  fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")
) as any;

test("generated WebSocket route description matches canonical OpenAPI", () => {
  const canonicalDescription = spec.paths["/api/v1/ws"]?.get?.description;
  const generatedEndpoint = OPENAPI_ENDPOINTS.find(
    (endpoint) => endpoint.path === "/api/v1/ws" && endpoint.method === "GET"
  );

  assert.equal(typeof canonicalDescription, "string");
  assert.ok(generatedEndpoint, "generated module includes GET /api/v1/ws");
  assert.equal(generatedEndpoint.description, canonicalDescription);
  assert.match(generatedEndpoint.description, /LIVE_WS_PORT=20132/);
  assert.match(generatedEndpoint.description, /path `\/live-ws`/);
});
