import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import {
  isDeploymentDraining,
  setDeploymentDraining,
  getCanaryLifecycle,
} from "../../src/lib/canaryLifecycle.ts";
import { isAlwaysProtectedPath } from "../../src/server/authz/routeGuard.ts";
const require = createRequire(import.meta.url);
const { attachCanaryLifecycle, wrapCanaryRequestListener } =
  require("../../scripts/dev/canary-lifecycle.cjs") as {
    attachCanaryLifecycle(server: http.Server): http.Server;
    wrapCanaryRequestListener(listener: http.RequestListener): http.RequestListener;
  };

test("response body lifetime and pending uploads stay tracked until actual completion", async () => {
  delete globalThis.__omnirouteCanaryLifecycle;
  process.env.OMNIROUTE_APP_GENERATION = "test-generation";
  let release!: () => void;
  let requestSeen!: () => void;
  const seen = new Promise<void>((r) => (requestSeen = r));
  const server = attachCanaryLifecycle(
    http.createServer(
      wrapCanaryRequestListener((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: beginning\n\n");
        release = () => res.end("data: done\n\n");
        requestSeen();
      })
    )
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const request = http.request({
    host: "127.0.0.1",
    port: addr.port,
    path: "/v1/responses",
    method: "POST",
    headers: { "Content-Length": "100" },
  });
  const response = new Promise<http.IncomingMessage>((r) => request.once("response", r));
  request.write("x");
  await seen;
  await response;
  assert.equal(getCanaryLifecycle().activeResponses, 1);
  assert.equal(getCanaryLifecycle().pendingUploads, 1);
  setDeploymentDraining("test-generation", true);
  assert.equal(isDeploymentDraining(), true);
  const rejected = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(rejected.status, 503);
  await rejected.text();
  assert.equal(getCanaryLifecycle().activeResponses, 1);
  setDeploymentDraining("test-generation", false);
  request.end("x".repeat(99));
  release();
  await new Promise<void>((r) => setTimeout(r, 20));
  assert.equal(getCanaryLifecycle().activeResponses, 0);
  assert.equal(getCanaryLifecycle().pendingUploads, 0);
  request.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
test("drain is generation-bound and separate from process termination", () => {
  process.env.OMNIROUTE_APP_GENERATION = "generation-b";
  assert.throws(() => setDeploymentDraining("stale-a", true), /mismatch/);
  setDeploymentDraining("generation-b", true);
  assert.equal(isDeploymentDraining(), true);
  setDeploymentDraining("generation-b", false);
  assert.equal(isDeploymentDraining(), false);
  assert.equal(isAlwaysProtectedPath("/api/canary-readiness"), true);
  assert.equal(isAlwaysProtectedPath("/api/canary-drain"), true);
});
test("absence of transport and state instrumentation is unknown, not an idle proof", () => {
  delete globalThis.__omnirouteCanaryLifecycle;
  const data = getCanaryLifecycle();
  assert.equal(data.activeResponses, null);
  assert.equal(data.activeWebSockets, null);
  assert.equal(data.conversationPins, null);
  assert.equal(data.upstreamLeases, null);
});
