"use strict";
const STATE_KEY = "__omnirouteCanaryLifecycle";
const TRACKED = Symbol.for("omniroute.canary.response.tracked");
const EXCLUDED = new Set([
  "/api/canary-readiness",
  "/api/canary-drain",
  "/api/health",
  "/api/health/ping",
]);
function state() {
  return (globalThis[STATE_KEY] ||= {
    version: 1,
    draining: false,
    activeResponses: 0,
    activeWebSockets: 0,
    pendingUploads: 0,
    queuedRequests: 0,
    attachedServers: 0,
    // Shared volatile stores/leases must register actual getters; unknown is not zero.
    providers: {},
  });
}
function path(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}
function trackHttp(req, res) {
  if (res[TRACKED] || EXCLUDED.has(path(req))) return;
  res[TRACKED] = true;
  const s = state();
  s.activeResponses++;
  let upload = !req.readableEnded && !req.complete && ["POST", "PUT", "PATCH"].includes(req.method);
  if (upload) s.pendingUploads++;
  const uploadDone = () => {
    if (!upload) return;
    upload = false;
    s.pendingUploads--;
    req.removeListener("end", uploadDone);
    req.removeListener("close", uploadDone);
    req.removeListener("error", uploadDone);
  };
  if (upload) {
    req.once("end", uploadDone);
    req.once("close", uploadDone);
    req.once("error", uploadDone);
  }
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    s.activeResponses--;
    uploadDone();
    res.removeListener("finish", done);
    res.removeListener("close", done);
    res.removeListener("error", done);
  };
  res.once("finish", done);
  res.once("close", done);
  res.once("error", done);
}
function attachCanaryLifecycle(server) {
  if (server[TRACKED]) return server;
  server[TRACKED] = true;
  const s = state();
  s.attachedServers++;
  server.prependListener("request", trackHttp);
  server.prependListener("upgrade", (_req, socket) => {
    s.activeWebSockets++;
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      s.activeWebSockets--;
      socket.removeListener("close", done);
    };
    socket.once("close", done);
  });
  server.once("close", () => {
    s.attachedServers--;
  });
  return server;
}
function wrapCanaryRequestListener(listener) {
  return function canaryRequest(req, res) {
    const generation = process.env.OMNIROUTE_APP_GENERATION;
    if (typeof generation === "string" && /^[a-f0-9]{32}$/.test(generation)) {
      res.setHeader("X-Omni-App-Generation", generation);
    }
    if (state().draining && !EXCLUDED.has(path(req))) {
      res.writeHead(503, {
        "Content-Type": "application/json",
        "Retry-After": "2",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: {
            code: "generation_draining",
            message: "This generation no longer accepts new requests.",
          },
        })
      );
      return;
    }
    return listener.call(this, req, res);
  };
}
module.exports = {
  attachCanaryLifecycle,
  getCanaryLifecycleState: state,
  wrapCanaryRequestListener,
};
