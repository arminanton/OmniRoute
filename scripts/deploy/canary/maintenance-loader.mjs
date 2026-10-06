#!/usr/bin/env node
// Root-reviewed overlay for /app/dev/run-standalone.mjs. Preserve its bootstrap
// and interpreter envelope; replace only the child entry with the fixed owner.
import { existsSync } from "node:fs";
import {
  resolveRuntimePorts,
  withRuntimePortEnv,
  spawnWithForwardedSignals,
} from "../build/runtime-env.mjs";
import { bootstrapEnv } from "../build/bootstrap-env.mjs";
import { getRuntimePolicy, RuntimePolicyError } from "../build/runtime-policy.mjs";
getRuntimePolicy();
if (!existsSync("server-ws.mjs") || !existsSync("maintenance-entry.cjs"))
  throw new RuntimePolicyError("bootstrap-invalid");
const env = bootstrapEnv();
const childEnv = withRuntimePortEnv(env, resolveRuntimePorts(env));
if (
  childEnv.OMNI_COORDINATION_PROCESS_ROLE !== "maintenance" ||
  childEnv.OMNI_SHARED_ADMISSION !== "true"
)
  throw new RuntimePolicyError("bootstrap-invalid");
for (const key of Object.keys(childEnv)) {
  if (/^(?:NODE_|LD_|DYLD_|OPENSSL_)|^(?:PATH|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key))
    delete childEnv[key];
}
delete childEnv.NEXT_MANUAL_SIG_HANDLE;
childEnv.PATH = "/usr/local/bin:/usr/bin:/bin";
childEnv.NODE_ENV = "production";
spawnWithForwardedSignals(
  process.execPath,
  ["--dns-result-order=ipv4first", "--max-old-space-size=2048", "/app/maintenance-entry.cjs"],
  { stdio: "inherit", env: childEnv }
);
