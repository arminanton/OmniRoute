#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  resolveRuntimePorts,
  withRuntimePortEnv,
  resolveMaxOldSpaceMb,
  warnConflictingHeapLimits,
  buildStandaloneNodeOptions,
  spawnWithForwardedSignals,
} from "../build/runtime-env.mjs";
import { bootstrapEnv } from "../build/bootstrap-env.mjs";
import { getRuntimePolicy, RuntimePolicyError } from "../build/runtime-policy.mjs";

// Validate the fixed authority before writable config is read or secrets are generated.
const runtimePolicy = getRuntimePolicy();
if (runtimePolicy.mode === "locked" && !existsSync("server-ws.mjs")) {
  throw new RuntimePolicyError("bootstrap-invalid");
}
const env = bootstrapEnv();
const runtimePorts = resolveRuntimePorts(env);
const childEnv = withRuntimePortEnv(env, runtimePorts);

if (runtimePolicy.mode === "locked") {
  // Apply this envelope AFTER bootstrap's persisted/.env/process merge. An empty
  // launcher env must not let writable config supply interpreter/loader/trust knobs.
  // New Node/OpenSSL loader options require explicit review, not implicit inheritance.
  for (const key of Object.keys(childEnv)) {
    if (/^(?:NODE_|LD_|DYLD_|OPENSSL_)|^(?:PATH|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key)) {
      delete childEnv[key];
    }
  }
  childEnv.PATH = "/usr/local/bin:/usr/bin:/bin";
  childEnv.NODE_ENV = "production";
  // The locked bootstrap above requires the trusted WS/peer-stamp wrapper.
  const entry = "server-ws.mjs";
  // Do not inherit execArgv or turn merged memory/loader settings into Node flags.
  // This protects executable/config integrity; it is not outbound enforcement.
  spawnWithForwardedSignals(
    process.execPath,
    ["--dns-result-order=ipv4first", "--max-old-space-size=2048", entry],
    { stdio: "inherit", env: childEnv }
  );
} else {
  // #2939 / #10353: OMNIROUTE_MEMORY_MB is the Docker/standalone heap knob.
  // When it is set, we append --max-old-space-size last (V8 last-flag wins).
  // When it is unset and NODE_OPTIONS already pins the heap, keep NODE_OPTIONS
  // (#5238). Warn when both are set and the numbers disagree.
  const maxOldSpaceMb = resolveMaxOldSpaceMb(childEnv.OMNIROUTE_MEMORY_MB);
  warnConflictingHeapLimits(childEnv, maxOldSpaceMb);
  childEnv.NODE_OPTIONS = buildStandaloneNodeOptions(childEnv, maxOldSpaceMb);

  // Prefer the WS-aware wrapper (server-ws.mjs) over the bare Next standalone
  // server.js: it installs the trusted peer-IP stamp (scripts/dev/peer-stamp.mjs)
  // that the authz middleware needs to allow loopback/LAN access to LOCAL_ONLY
  // routes. Falling back to server.js fails CLOSED (every LOCAL_ONLY request 403s)
  // rather than trusting the spoofable Host header.
  const entry = existsSync("server-ws.mjs") ? "server-ws.mjs" : "server.js";

  spawnWithForwardedSignals("node", [entry], {
    stdio: "inherit",
    env: childEnv,
  });
}
