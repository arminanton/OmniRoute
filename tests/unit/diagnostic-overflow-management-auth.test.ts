import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import {
  listPrivateOverflow,
  inspectPrivateOverflow,
  downloadPrivateOverflow,
  privateOverflowHead,
} from "../../src/lib/usage/diagnosticOverflowManagement.ts";
import { createAccessToken } from "../../src/lib/db/accessTokens.ts";
import { createApiKey } from "../../src/lib/db/apiKeys.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";
const oldSecret = process.env.API_KEY_SECRET;
process.env.API_KEY_SECRET = "synthetic-overflow-api-key-secret";
after(() => {
  resetDbInstance();
  if (oldSecret === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = oldSecret;
});
const TRACE = "11111111-1111-4111-8111-111111111111";
const request = (token?: string, path = "/api/usage/diagnostic-overflow") =>
  new Request("http://127.0.0.1:20128" + path, {
    headers: token ? { authorization: "Bearer " + token } : {},
  });

test("private complete payload surfaces always requireauth despite unlocked localhost", async () => {
  assert.equal((await listPrivateOverflow(request())).status, 401);
  assert.equal((await inspectPrivateOverflow(request(), TRACE)).status, 401);
  assert.equal((await downloadPrivateOverflow(request(), TRACE, TRACE, "request")).status, 401);
  assert.equal((await privateOverflowHead(request())).status, 401);
  assert.equal(
    (await listPrivateOverflow(request(undefined, "/api/usage/diagnostic-overflow?api_key=fake")))
      .status,
    401
  );
});
test("read/write CLI tokens cannot access private provider payloads; admincan validatealias", async () => {
  for (const scope of ["read", "write"] as const) {
    const { secret } = createAccessToken({ name: "overflow-" + scope, scope });
    assert.equal((await listPrivateOverflow(request(secret))).status, 403);
  }
  const { secret } = createAccessToken({ name: "overflow-admin", scope: "admin" });
  assert.equal((await inspectPrivateOverflow(request(secret), "../arbitrary")).status, 400);
  assert.equal((await privateOverflowHead(request(secret))).status, 405);
  assert.equal(
    (await downloadPrivateOverflow(request(secret), TRACE, TRACE, "../../secret")).status,
    400
  );
  assert.equal(
    (
      await downloadPrivateOverflow(
        request(secret),
        TRACE,
        "22222222-2222-4222-8222-222222222222",
        "client-request"
      )
    ).status,
    400
  );
  assert.equal(
    (await listPrivateOverflow(request(secret, "/api/usage/diagnostic-overflow?limit=101"))).status,
    400
  );
});
test("ordinary inferenceAPIkey lacksmanagementscope; managerkey reachesvalidatedinput", async () => {
  const infer = await createApiKey("fixture-inference", "fixture-machine", []);
  const manager = await createApiKey("fixture-manager", "fixture-machine", ["manage"]);
  assert.equal((await inspectPrivateOverflow(request(infer.key), "bad-trace")).status, 403);
  assert.equal((await inspectPrivateOverflow(request(manager.key), "bad-trace")).status, 400);
  assert.equal(inferRequiredScope("GET", "/api/usage/diagnostic-overflow/" + TRACE), "admin");
  assert.equal(inferRequiredScope("GET", "/api/usage/diagnostic-overflow-lookalike"), "read");
});
