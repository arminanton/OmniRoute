import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveAccountSelectionScope } from "../../open-sse/handlers/chatCore/accountSelectionScope.ts";
test("unrestricted API-key list stays null while explicit empty intersections never widen", () => {
  assert.equal(resolveAccountSelectionScope(null, []).allowedConnectionIds, null);
  assert.deepEqual(
    resolveAccountSelectionScope({ allowedConnectionIds: [] }, ["other"]).allowedConnectionIds,
    []
  );
  assert.deepEqual(resolveAccountSelectionScope(null, ["allowed"]).allowedConnectionIds, [
    "allowed",
  ]);
});
test("routing-layer pin and effective allowlist traverse dispatch and both Core policy paths", () => {
  const dispatch = fs.readFileSync("src/sse/handlers/chat.ts", "utf8");
  const helper = fs.readFileSync("src/sse/handlers/chatHelpers.ts", "utf8");
  const core = fs.readFileSync("open-sse/handlers/chatCore.ts", "utf8");
  const leg = fs.readFileSync("open-sse/handlers/chatCore/nonStreamingProviderLeg.ts", "utf8");
  assert.match(
    dispatch,
    /accountSelectionScope:\s*\{\s*pinnedConnectionId: forcedConnectionId \|\| null,\s*allowedConnectionIds: effectiveAllowedConnections/
  );
  assert.match(helper, /credentials: refreshedCredentials,\s*accountSelectionScope,/);
  assert.equal(
    (core.match(/pinnedConnectionId: selectionScope.pinnedConnectionId/g) || []).length,
    2
  );
  assert.match(leg, /pinnedConnectionId: input.pinnedConnectionId/);
  assert.match(leg, /allowedConnectionIds: input.allowedConnectionIds/);
});
