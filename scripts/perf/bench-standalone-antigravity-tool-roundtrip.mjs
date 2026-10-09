#!/usr/bin/env node
/**
 * Full standalone HTTP acceptance harness for synthetic Antigravity tool calls.
 * No provider credentials or public provider calls are used. The built app is
 * read-only; all SQLite, call-log, private-trace, XDG and fetch-audit data live
 * in one fresh /tmp directory owned by this invocation.
 *
 * Build the candidate separately, then run this on an otherwise idle test host:
 *   OMNIROUTE_STANDALONE_CAPTURE=private \
 *   ANTIGRAVITY_CAPTURE_CONTEXT_BYTES=200000 \
 *   ANTIGRAVITY_CAPTURE_REQUEST_TIMEOUT_MS=120000 \
 *   systemd-run --user --scope --property=MemoryHigh=2G \
 *     --property=MemoryMax=3G --property=CPUQuota=200% \
 *     node --import tsx/esm scripts/perf/bench-standalone-antigravity-tool-roundtrip.mjs
 *
 * Capture modes: none (default), artifact, private. The default phases are
 * 1,30,70,100 conversations; override with ANTIGRAVITY_CAPTURE_SESSION_COUNTS.
 * Override the direct Undici socket-pool size with --direct-dispatcher-connections=N
 * to compare queueing behavior; the default mirrors production (32).
 * Set OMNIROUTE_KEEP_STANDALONE_E2E_FAILURES=1 to retain only failed-run scratch
 * for diagnosis. Successful runs always remove their temporary files.
 * This harness intentionally refuses to build the standalone artifact.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CAPTURE_MODES = new Set(["none", "artifact", "private"]);
const LOG_TAIL_LIMIT = 24_000;
const CALL_LOG_DRAIN_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 120_000;
// Source DB imports below may initialize ProxyFetch in this process. Harness
// health/mock/cancellation checks must keep using Node's original loopback fetch.
const harnessFetch = globalThis.fetch.bind(globalThis);

function positiveInt(value, fallback, label, maximum) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new RangeError(`${label} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

function parsePhases(value) {
  const phases = String(value || "1,30,70,100")
    .split(",")
    .map((item) => Number(item.trim()));
  if (
    phases.length === 0 ||
    phases.some((count) => !Number.isInteger(count) || count <= 0 || count > 100) ||
    new Set(phases).size !== phases.length
  ) {
    throw new RangeError(
      "ANTIGRAVITY_CAPTURE_SESSION_COUNTS must contain unique counts from 1 through 100"
    );
  }
  return phases;
}

function trimTail(current, chunk) {
  return (current + chunk).slice(-LOG_TAIL_LIMIT);
}

function readAvailableBytes(directory) {
  try {
    const stats = fs.statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function validatePrivateScratchParent(directory) {
  const absolute = path.resolve(directory);
  const uid = process.getuid?.();
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`scratch parent contains a non-directory or symlink: ${current}`);
    }
    if (stat.uid !== 0 && stat.uid !== uid) {
      throw new Error(`scratch parent has an unexpected owner: ${current}`);
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`scratch parent is group/world writable: ${current}`);
    }
  }
  const stat = fs.lstatSync(absolute);
  if (stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new Error(
      `scratch parent must be owned by this user and non-writable by others: ${absolute}`
    );
  }
}

function createPrivateScratchRoot() {
  const home = path.resolve(os.homedir());
  const scratchParent = path.join(home, ".cache");
  fs.mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  validatePrivateScratchParent(scratchParent);
  const scratchRoot = fs.mkdtempSync(path.join(scratchParent, "omni-standalone-ag-e2e-"));
  fs.chmodSync(scratchRoot, 0o700);
  return { scratchParent, scratchRoot };
}

function readHostMemoryAvailableBytes() {
  try {
    const line = fs
      .readFileSync("/proc/meminfo", "utf8")
      .split("\n")
      .find((item) => item.startsWith("MemAvailable:"));
    const kib = Number(line?.match(/\d+/)?.[0]);
    return Number.isFinite(kib) ? kib * 1024 : null;
  } catch {
    return null;
  }
}

function currentCgroupDirectory(pid = process.pid) {
  try {
    const membership = fs
      .readFileSync(`/proc/${pid}/cgroup`, "utf8")
      .split("\n")
      .find((line) => line.startsWith("0::"));
    if (!membership) return null;
    const relative = membership.slice(3).replace(/^\/+/, "");
    const root = "/sys/fs/cgroup";
    const directory = path.join(root, relative);
    return directory.startsWith(`${root}${path.sep}`) ? directory : null;
  } catch {
    return null;
  }
}

function readCgroupValue(directory, name) {
  if (!directory) return null;
  try {
    const value = fs.readFileSync(path.join(directory, name), "utf8").trim();
    return value === "max" ? null : Number(value);
  } catch {
    return null;
  }
}

function readCgroupKeyValues(directory, name) {
  if (!directory) return null;
  try {
    const values = {};
    for (const line of fs.readFileSync(path.join(directory, name), "utf8").split("\n")) {
      const [key, raw] = line.trim().split(/\s+/, 2);
      if (key && raw !== undefined && Number.isFinite(Number(raw))) values[key] = Number(raw);
    }
    return values;
  } catch {
    return null;
  }
}

function readCgroupPressure(directory, name) {
  if (!directory) return null;
  try {
    return fs.readFileSync(path.join(directory, name), "utf8").trim();
  } catch {
    return null;
  }
}

function snapshotCgroup(directory) {
  return {
    memoryCurrentBytes: readCgroupValue(directory, "memory.current"),
    memoryPeakBytes: readCgroupValue(directory, "memory.peak"),
    memoryMaxBytes: readCgroupValue(directory, "memory.max"),
    memoryHighBytes: readCgroupValue(directory, "memory.high"),
    memoryEvents: readCgroupKeyValues(directory, "memory.events"),
    cpu: readCgroupKeyValues(directory, "cpu.stat"),
    memoryPressure: readCgroupPressure(directory, "memory.pressure"),
    cpuPressure: readCgroupPressure(directory, "cpu.pressure"),
  };
}

function assertBoundedHarnessCgroup() {
  const directory = currentCgroupDirectory();
  const memoryMaxBytes = readCgroupValue(directory, "memory.max");
  const memoryHighBytes = readCgroupValue(directory, "memory.high");
  let cpuMax = "";
  try {
    if (directory) cpuMax = fs.readFileSync(path.join(directory, "cpu.max"), "utf8").trim();
  } catch {
    cpuMax = "";
  }
  const [quota, period] = cpuMax.split(/\s+/, 2).map(Number);
  if (
    memoryMaxBytes === null ||
    memoryHighBytes === null ||
    memoryMaxBytes > 3 * GIB ||
    memoryHighBytes > 2 * GIB ||
    !Number.isFinite(quota) ||
    !Number.isFinite(period) ||
    period <= 0 ||
    quota / period > 2
  ) {
    throw new Error(
      "load harness must run in a cgroup-v2 scope capped at MemoryHigh<=2 GiB, MemoryMax<=3 GiB and CPUQuota<=200%"
    );
  }
  return {
    memoryHighBytes,
    memoryMaxBytes,
    cpuQuotaCores: Number((quota / period).toFixed(2)),
  };
}

function systemctlUser(args, { allowFailure = false, timeout = 5_000 } = {}) {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || (result.status !== 0 && !allowFailure)) {
    const detail = String(result.stderr || result.error?.message || `exit ${result.status}`).trim();
    throw new Error(`systemctl --user ${args[0]} failed: ${detail.slice(0, 400)}`);
  }
  return String(result.stdout || "").trim();
}

function writeSystemdEnvironmentFile(filename, env) {
  const contents = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join("\n");
  fs.writeFileSync(filename, `${contents}\n`, { mode: 0o600, flag: "wx" });
}

function startStandaloneService({ unit, standaloneDir, environmentFile, nodePath }) {
  const args = [
    "--user",
    `--unit=${unit}`,
    "--collect",
    "--property=Type=exec",
    `--property=WorkingDirectory=${standaloneDir}`,
    `--property=EnvironmentFile=${environmentFile}`,
    "--property=MemoryHigh=3G",
    "--property=MemoryMax=4G",
    "--property=CPUQuota=200%",
    "--property=TasksMax=256",
    "--property=TimeoutStopSec=15s",
    "--property=RuntimeMaxSec=15min",
    nodePath,
    "dev/run-standalone.mjs",
  ];
  const result = spawnSync("systemd-run", args, {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || `exit ${result.status}`).trim();
    throw new Error(`could not start isolated standalone service: ${detail.slice(0, 600)}`);
  }
  return String(result.stdout || "").trim();
}

function standaloneUnitCgroup(unit) {
  const controlGroup = systemctlUser(["show", "--property=ControlGroup", "--value", unit]);
  if (!controlGroup.startsWith("/")) throw new Error("systemd did not expose the app ControlGroup");
  const directory = path.join("/sys/fs/cgroup", controlGroup.replace(/^\/+/, ""));
  const maxBytes = readCgroupValue(directory, "memory.max");
  const highBytes = readCgroupValue(directory, "memory.high");
  if (maxBytes !== 4 * GIB || highBytes !== 3 * GIB) {
    throw new Error("standalone service cgroup did not apply the required 3/4 GiB memory bounds");
  }
  return directory;
}

function stopStandaloneService(unit) {
  if (!unit) return;
  systemctlUser(["stop", unit], { allowFailure: true, timeout: 20_000 });
}

function readStandaloneJournal(unit) {
  if (!unit) return "";
  const result = spawnSync(
    "journalctl",
    ["--user", "--unit", unit, "--no-pager", "--output=cat", "--lines=120"],
    { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] }
  );
  return trimTail(String(result.stdout || result.stderr || ""), 16_000);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : 0;
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function spawnTracked(command, args, options = {}) {
  const child = spawn(command, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => (stdout = trimTail(stdout, chunk)));
  child.stderr?.on("data", (chunk) => (stderr = trimTail(stderr, chunk)));
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get output() {
      return trimTail(`${stdout}\n${stderr}`, LOG_TAIL_LIMIT);
    },
  };
}

async function stopChild(child, timeoutMs = 8_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function startMock(fixturePath) {
  const fixture = spawnTracked(process.execPath, [fixturePath], {
    cwd: PROJECT_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME || os.homedir(),
      ANTIGRAVITY_CAPTURE_MEMORY_BENCH: "0",
      ANTIGRAVITY_UPSTREAM_DELAY_MS: process.env.ANTIGRAVITY_UPSTREAM_DELAY_MS || "1500",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const findUrl = () => fixture.stdout.match(/LISTENING (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    const alreadyListening = findUrl();
    const url =
      alreadyListening ??
      (await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Antigravity mock did not start in 10s")),
          10_000
        );
        fixture.child.stdout?.on("data", () => {
          const match = findUrl();
          if (match) {
            clearTimeout(timeout);
            resolve(match);
          }
        });
        fixture.child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        fixture.child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          reject(new Error(`Antigravity mock exited before listen (${code ?? signal})`));
        });
      }));
    return {
      child: fixture.child,
      get output() {
        return `${fixture.stdout}\n${fixture.stderr}`;
      },
      url,
    };
  } catch (error) {
    await stopChild(fixture.child);
    throw error;
  }
}

function createSyntheticTlsCertificate(scratchRoot) {
  const certificateDirectory = path.join(scratchRoot, "tls");
  fs.mkdirSync(certificateDirectory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(certificateDirectory, "key.pem");
  const certificatePath = path.join(certificateDirectory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=cloudcode-pa.googleapis.com",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "subjectAltName=DNS:daily-cloudcode-pa.googleapis.com,DNS:cloudcode-pa.googleapis.com,DNS:antigravity-auto-updater-974169037036.us-central1.run.app,DNS:api.github.com,IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
    ],
    { stdio: "ignore", timeout: 10_000 }
  );
  return { keyPath, certificatePath };
}

async function startSyntheticTlsBridge(mockUrl, certificate) {
  const mock = new URL(mockUrl);
  const bridgeStartedAt = Date.now();
  const state = {
    providerRequests: 0,
    versionResponses: 0,
    unexpectedRequests: 0,
    errors: 0,
    requestBodiesAborted: 0,
    upstreamResponsesStarted: 0,
    upstreamResponsesCompleted: 0,
    upstreamResponsesAborted: 0,
    clientResponsesCompleted: 0,
    clientResponsesAborted: 0,
    upstreamErrorsByCode: {},
    upstreamErrorEvents: [],
  };
  const server = https.createServer(
    {
      key: fs.readFileSync(certificate.keyPath),
      cert: fs.readFileSync(certificate.certificatePath),
    },
    (incoming, outgoing) => {
      const requestUrl = new URL(
        incoming.url || "/",
        `https://${incoming.headers.host || "localhost"}`
      );
      const host = normalizedHostname(incoming.headers.host || requestUrl.hostname);
      if (requestUrl.pathname === "/releases" && host.includes("antigravity-auto-updater")) {
        state.versionResponses++;
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify([{ version: "2.5.5" }]));
        return;
      }
      if (
        requestUrl.pathname === "/repos/google-antigravity/antigravity-cli/releases/latest" &&
        host === "api.github.com"
      ) {
        state.versionResponses++;
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ tag_name: "v1.2.16" }));
        return;
      }
      if (requestUrl.pathname !== "/v1internal:streamGenerateContent") {
        state.unexpectedRequests++;
        outgoing.writeHead(404, { "content-type": "application/json" });
        outgoing.end('{"error":{"message":"synthetic TLS bridge route not found"}}');
        incoming.resume();
        return;
      }

      state.providerRequests++;
      incoming.once("aborted", () => {
        state.requestBodiesAborted++;
      });
      outgoing.once("finish", () => {
        state.clientResponsesCompleted++;
      });
      outgoing.once("close", () => {
        if (!outgoing.writableFinished) state.clientResponsesAborted++;
      });
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: Number(mock.port),
          method: incoming.method,
          path: `${requestUrl.pathname}${requestUrl.search}`,
          headers: { ...incoming.headers, host: `127.0.0.1:${mock.port}` },
        },
        (response) => {
          state.upstreamResponsesStarted++;
          response.once("end", () => {
            state.upstreamResponsesCompleted++;
          });
          response.once("aborted", () => {
            state.upstreamResponsesAborted++;
          });
          const headers = { ...response.headers };
          delete headers.connection;
          delete headers["keep-alive"];
          delete headers["transfer-encoding"];
          outgoing.writeHead(response.statusCode || 502, headers);
          response.pipe(outgoing);
        }
      );
      incoming.once("aborted", () => upstream.destroy());
      outgoing.once("close", () => {
        if (!outgoing.writableEnded) upstream.destroy();
      });
      upstream.once("error", (error) => {
        state.errors++;
        const rawCode = typeof error.code === "string" ? error.code : "";
        const code = /^(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_[A-Z0-9_]{1,48})$/.test(
          rawCode
        )
          ? rawCode
          : "other";
        state.upstreamErrorsByCode[code] = (state.upstreamErrorsByCode[code] || 0) + 1;
        if (state.upstreamErrorEvents.length < 32) {
          state.upstreamErrorEvents.push({
            timestamp: Date.now(),
            elapsedMs: Date.now() - bridgeStartedAt,
            code,
          });
        }
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(upstream);
    }
  );
  server.on("tlsClientError", () => {
    // The preload's local-only socket self-check closes after TLS handshake.
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("synthetic TLS bridge failed to bind");
  return {
    server,
    port: address.port,
    snapshot: () => ({
      ...state,
      upstreamErrorsByCode: { ...state.upstreamErrorsByCode },
      upstreamErrorEvents: [...state.upstreamErrorEvents],
      upstreamResponsesActive: Math.max(
        0,
        state.upstreamResponsesStarted -
          state.upstreamResponsesCompleted -
          state.upstreamResponsesAborted
      ),
      clientResponsesActive: Math.max(
        0,
        state.providerRequests - state.clientResponsesCompleted - state.clientResponsesAborted
      ),
    }),
    close: async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function normalizedHostname(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split(":", 1)[0]
    .replace(/\.$/, "");
}

async function waitForReady(baseUrl, server, apiKey) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    const active = systemctlUser(["is-active", server.unit], { allowFailure: true });
    if (active !== "active" && active !== "activating") {
      throw new Error(`standalone service ${server.unit} is ${active || "inactive"}`);
    }
    try {
      const response = await harnessFetch(`${baseUrl}/api/health`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(2_000),
      });
      const body = await response.json();
      if (response.status === 200 && body?.status === "ok") return;
      lastError = `health status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`standalone health probe timed out (${lastError}; unit=${server.unit})`);
}

function readCallLogRows(dataDir, apiKeyId) {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const databasePath = path.join(dataDir, "storage.sqlite");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT id, artifact_relpath AS artifactRelpath, detail_state AS detailState,
                error_summary AS errorSummary, connection_id AS connectionId
           FROM call_logs WHERE api_key_id = ? ORDER BY timestamp ASC, id ASC`
      )
      .all(apiKeyId);
  } finally {
    db.close();
  }
}

async function waitForCallLogs(dataDir, apiKeyId, expected) {
  const deadline = Date.now() + CALL_LOG_DRAIN_TIMEOUT_MS;
  let rows = [];
  while (Date.now() < deadline) {
    rows = readCallLogRows(dataDir, apiKeyId);
    // A call-log row is committed only after detail preparation and artifact
    // persistence have finished. `missing` (for example, the preparation
    // memory budget refusing capture) is terminal too; wait for the expected
    // rows, then let inspectCapture report ready/missing/corrupt counts.
    if (rows.length >= expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return rows;
}

async function waitForMockStats(mockUrl) {
  const response = await harnessFetch(`${mockUrl}/__stats`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`mock stats returned HTTP ${response.status}`);
  return response.json();
}

async function waitForMockSession(mockUrl, sessionId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = await waitForMockStats(mockUrl);
    if ((stats.receivedAtBySession?.[sessionId] ?? []).length > 0) return stats;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`synthetic cancellation request ${sessionId} never reached the mock`);
}

async function runCancellationProbe(baseUrl, mockUrl, apiKey) {
  const sessionId = "cancel-probe";
  const controller = new AbortController();
  const pending = harnessFetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-omniroute-session-id": sessionId,
    },
    body: JSON.stringify({
      model: "antigravity/gemini-2.5-flash",
      stream: true,
      messages: [{ role: "user", content: `session:${sessionId}|turn:0\nsynthetic cancel probe` }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: {
              type: "object",
              properties: { session: { type: "string" } },
              required: ["session"],
            },
          },
        },
      ],
    }),
    signal: controller.signal,
  });
  const settled = pending.then(
    (response) => ({ response }),
    (error) => ({ error })
  );
  await waitForMockSession(mockUrl, sessionId);
  controller.abort(new Error("synthetic standalone cancellation probe"));
  const outcome = await Promise.race([
    settled,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
  ]);
  assert.notEqual(outcome, "timeout", "client cancellation must settle the HTTP request promptly");
  if (outcome?.response instanceof Response) await outcome.response.body?.cancel().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stats = await waitForMockStats(mockUrl);
  assert.equal(
    (stats.completedAtBySession?.[sessionId] ?? []).length,
    0,
    "mock upstream must observe cancellation before finishing its delayed stream"
  );
  return stats;
}

function parseAuditFiles(auditDirectory) {
  const result = {
    cloudCodeFetchRewrites: 0,
    syntheticVersionResponses: 0,
    cloudCodeDnsRedirects: 0,
    cloudCodeTlsRoutes: 0,
    cloudCodeSocketRoutes: 0,
    loopbackSockets: 0,
    blockedFetches: 0,
    blockedDnsLookups: 0,
    blockedSockets: 0,
    blockedSocketReasons: {
      unixDomain: 0,
      unexpectedSyntheticPort: 0,
      reservedSentinel: 0,
      nonLoopbackTcp: 0,
      unsupportedTcp: 0,
      unexpectedSyntheticTlsPort: 0,
      nonLoopbackTls: 0,
      unsupportedTls: 0,
    },
    blockedSocketTargets: [],
    blockedDatagrams: 0,
    tcpSocketErrors: 0,
    tlsSocketErrors: 0,
    socketInformationalEvents: 0,
    socketErrorsByCode: {},
    socketErrorEvents: [],
    preloadLocalTlsSelfChecks: 0,
  };
  for (const name of fs.readdirSync(auditDirectory)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const item = JSON.parse(fs.readFileSync(path.join(auditDirectory, name), "utf8"));
    for (const key of Object.keys(result)) {
      if (key === "blockedSocketReasons") {
        for (const reason of Object.keys(result.blockedSocketReasons)) {
          result.blockedSocketReasons[reason] += Number(item.blockedSocketReasons?.[reason] || 0);
        }
      } else if (key === "blockedSocketTargets") {
        for (const target of item.blockedSocketTargets || []) {
          if (result.blockedSocketTargets.length >= 8) break;
          const duplicate = result.blockedSocketTargets.some(
            (existing) =>
              existing.reason === target.reason &&
              existing.host === target.host &&
              existing.port === target.port
          );
          if (!duplicate) result.blockedSocketTargets.push(target);
        }
      } else if (key === "socketErrorsByCode") {
        for (const [code, count] of Object.entries(item.socketErrorsByCode || {})) {
          result.socketErrorsByCode[code] =
            (result.socketErrorsByCode[code] || 0) + Number(count || 0);
        }
      } else if (key === "socketErrorEvents") {
        for (const event of item.socketErrorEvents || []) {
          if (result.socketErrorEvents.length >= 64) break;
          result.socketErrorEvents.push({
            processId: Number.parseInt(name, 10),
            ...event,
          });
        }
      } else {
        result[key] += Number(item[key] || 0);
      }
    }
  }
  return result;
}

async function readPrivateFile(diagnosticOverflow, traceId, attemptId, kind) {
  const opened = await diagnosticOverflow.openDiagnosticOverflowFile(traceId, attemptId, kind);
  assert.equal(opened.state, "ready", `expected persisted ${kind} for synthetic trace`);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  return gunzipSync(Buffer.concat(chunks));
}

async function waitForPrivateManifests(diagnosticOverflow, traceIds, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let manifests = [];
  while (Date.now() < deadline) {
    manifests = await Promise.all(
      traceIds.map((traceId) => diagnosticOverflow.readDiagnosticOverflowManifest(traceId))
    );
    if (manifests.every((manifest) => manifest && manifest.state !== "capturing")) return manifests;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return manifests;
}

async function inspectCapture({
  captureMode,
  rows,
  expectedRequests,
  expectedConversations,
  contextBytes,
}) {
  if (captureMode === "none") {
    return { rows: rows.length, artifacts: 0, traces: 0, accountConnections: null };
  }

  assert.equal(rows.length, expectedRequests, "one summary row is required per authenticated turn");
  assert.ok(
    rows.every((row) => row.detailState === "ready" && typeof row.artifactRelpath === "string"),
    `all ${expectedRequests} summaries must have ready detail artifacts; missing=${JSON.stringify(
      rows
        .filter((row) => row.detailState !== "ready")
        .reduce((counts, row) => {
          const reason = String(row.errorSummary || row.detailState || "unknown");
          counts[reason] = (counts[reason] || 0) + 1;
          return counts;
        }, {})
    )}`
  );
  const selectedConnectionIds = new Set(rows.map((row) => row.connectionId).filter(Boolean));
  const minimumSelectedConnections = Math.min(2, expectedConversations);
  assert.ok(
    selectedConnectionIds.size >= minimumSelectedConnections,
    `captured requests must show at least ${minimumSelectedConnections} synthetic Antigravity account connection(s)`
  );

  const { CALL_LOGS_DIR, readCallArtifact } =
    await import("../../src/lib/usage/callLogArtifacts.ts");
  assert.ok(CALL_LOGS_DIR);
  const paths = new Set(rows.map((row) => row.artifactRelpath));
  assert.equal(paths.size, expectedRequests, "every turn needs a distinct artifact file");
  const artifacts = rows.map((row) => {
    const detail = readCallArtifact(row.artifactRelpath);
    assert.equal(detail.state, "ready", `call-log artifact ${row.id} must parse`);
    assert.ok(detail.artifact, `call-log artifact ${row.id} must contain detail`);
    return detail.artifact;
  });
  const streamed = artifacts.find((artifact) => {
    const chunks = artifact?.pipeline?.streamChunks;
    return chunks && Object.keys(chunks).length > 0;
  });
  assert.ok(streamed, "stream capture must retain at least one stream leg");

  if (captureMode === "artifact" && contextBytes > 0) {
    const fullRequestArtifact = artifacts.find((artifact) => {
      const messages = artifact?.pipeline?.clientRawRequest?.body?.messages;
      const totalBytes = Array.isArray(messages)
        ? messages.reduce(
            (total, message) =>
              total +
              (typeof message?.content === "string" ? Buffer.byteLength(message.content) : 0),
            0
          )
        : 0;
      return totalBytes >= contextBytes * 5;
    });
    assert.ok(fullRequestArtifact, "artifact capture must retain the high-context client request");
  }

  let traceIds = [];
  if (captureMode === "private") {
    const { projectDiagnosticOverflowReference } =
      await import("../../src/lib/usage/diagnosticOverflowTypes.ts");
    const diagnosticOverflow = await import("../../src/lib/usage/diagnosticOverflow.ts");
    traceIds = artifacts.map((artifact, index) => {
      const reference = projectDiagnosticOverflowReference(artifact?.pipeline?.diagnosticOverflow);
      assert.ok(
        reference?.traceId,
        `artifact ${rows[index].id} must retain its private trace pointer`
      );
      assert.equal(artifact?.pipeline?.diagnosticOverflowOnly, true);
      assert.equal(artifact?.pipeline?.clientRawRequest?.body, undefined);
      assert.equal(artifact?.pipeline?.providerRequest?.body, undefined);
      assert.equal(artifact?.pipeline?.providerResponse?.body, undefined);
      return reference.traceId;
    });
    assert.equal(new Set(traceIds).size, expectedRequests, "each turn needs its own trace");

    const manifests = await waitForPrivateManifests(diagnosticOverflow, traceIds);
    assert.ok(
      manifests.every(
        (manifest) =>
          manifest?.state === "complete" &&
          manifest.clientRequest?.complete === true &&
          manifest.attempts.length >= 1 &&
          manifest.attempts.every(
            (attempt) => attempt.request.complete === true && attempt.response.complete === true
          )
      ),
      "all private traces must retain complete client/provider requests and responses"
    );
    const sample = manifests[0];
    const sampleClient = await readPrivateFile(
      diagnosticOverflow,
      sample.traceId,
      sample.traceId,
      "client-request"
    );
    const lastAttempt = sample.attempts.at(-1);
    const sampleResponse = await readPrivateFile(
      diagnosticOverflow,
      sample.traceId,
      lastAttempt.attemptId,
      "response"
    );
    assert.ok(sampleClient.byteLength >= contextBytes * 5);
    assert.match(sampleClient.toString("utf8"), /session:conversation-/);
    assert.match(sampleResponse.toString("utf8"), /data: /);
  }

  return {
    rows: rows.length,
    artifacts: paths.size,
    traces: traceIds.length,
    accountConnections: selectedConnectionIds.size,
  };
}

async function seedDatabase(dataDir, env, mockUrl, captureMode) {
  Object.assign(process.env, env, { DATA_DIR: dataDir, NODE_ENV: "test" });
  console.error("[standalone-antigravity-e2e] seed_stage=imports");
  const [core, providers, apiKeys, settings] = await Promise.all([
    import("../../src/lib/db/core.ts"),
    import("../../src/lib/db/providers.ts"),
    import("../../src/lib/db/apiKeys.ts"),
    import("../../src/lib/db/settings.ts"),
  ]);
  console.error("[standalone-antigravity-e2e] seed_stage=database_init");
  await core.ensureDbInitialized();
  console.error("[standalone-antigravity-e2e] seed_stage=settings");
  await settings.updateSettings({
    requireLogin: false,
    setupComplete: true,
    call_log_pipeline_enabled: captureMode !== "none",
    sessionAffinityTtlMs: 60_000,
    compression: { enabled: false },
    resilienceSettings: {
      quotaPreflight: { enabled: false },
      requestQueue: {
        autoEnableApiKeyProviders: false,
        globalConcurrentRequests: 0,
        maxWaitMs: 120_000,
        maxQueueDepth: 256,
      },
    },
  });
  for (const profile of ["cli", "ide"]) {
    console.error(`[standalone-antigravity-e2e] seed_stage=connection_${profile}`);
    await providers.createProviderConnection({
      provider: "antigravity",
      authType: "oauth",
      name: `standalone-e2e-${profile}`,
      accessToken: `synthetic-${profile}-access-token`,
      refreshToken: `synthetic-${profile}-refresh-token`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      isActive: true,
      testStatus: "active",
      providerSpecificData: { projectId: "synthetic-project", clientProfile: profile },
    });
  }
  console.error("[standalone-antigravity-e2e] seed_stage=api_keys");
  const apiKey = await apiKeys.createApiKey("standalone-antigravity-e2e", "synthetic-e2e-machine");
  const cancelApiKey = await apiKeys.createApiKey(
    "standalone-antigravity-cancel-e2e",
    "synthetic-cancel-machine"
  );
  await apiKeys.updateApiKeyPermissions(apiKey.id, {
    noLog: captureMode === "none",
    compressionEnabled: false,
  });
  await apiKeys.updateApiKeyPermissions(cancelApiKey.id, {
    noLog: true,
    compressionEnabled: false,
  });
  console.error("[standalone-antigravity-e2e] seed_stage=database_close");
  // An active dummy OpenAI connection is not needed: the provider URL is routed
  // by the test-only fetch preloader, while the Antigravity credentials remain
  // synthetic OAuth values stored only in this temporary database.
  assert.match(mockUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  core.closeDbInstance({ checkpointMode: null });
  console.error("[standalone-antigravity-e2e] seed_stage=complete");
  return { apiKey, cancelApiKey };
}

async function main() {
  const options = Object.fromEntries(
    process.argv.slice(2).map((argument) => {
      const separator = argument.indexOf("=");
      if (!argument.startsWith("--") || separator < 3) {
        throw new Error(`Invalid option: ${argument}`);
      }
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    })
  );
  const unknown = Object.keys(options).filter(
    (key) =>
      ![
        "capture",
        "phases",
        "context-bytes",
        "request-timeout-ms",
        "standalone-dir",
        "direct-dispatcher-connections",
      ].includes(key)
  );
  if (unknown.length) throw new Error(`Unknown options: ${unknown.join(", ")}`);

  const captureMode = options.capture || process.env.OMNIROUTE_STANDALONE_CAPTURE || "none";
  if (!CAPTURE_MODES.has(captureMode))
    throw new Error("--capture must be none, artifact, or private");
  const phases = parsePhases(options.phases || process.env.ANTIGRAVITY_CAPTURE_SESSION_COUNTS);
  const contextBytes = positiveInt(
    options["context-bytes"] || process.env.ANTIGRAVITY_CAPTURE_CONTEXT_BYTES,
    200_000,
    "context-bytes",
    1_000_000
  );
  const requestTimeoutMs = positiveInt(
    options["request-timeout-ms"] || process.env.ANTIGRAVITY_CAPTURE_REQUEST_TIMEOUT_MS,
    120_000,
    "request-timeout-ms",
    600_000
  );
  const directDispatcherConnections = positiveInt(
    options["direct-dispatcher-connections"] ||
      process.env.ANTIGRAVITY_CAPTURE_DIRECT_DISPATCHER_CONNECTIONS,
    32,
    "direct-dispatcher-connections",
    256
  );
  const sessionCount = phases.reduce((total, count) => total + count, 0);
  const expectedRequests = sessionCount * 2;
  if (sessionCount > 202)
    throw new RangeError("a run may contain at most 202 synthetic conversations");
  const standaloneDir = path.resolve(
    options["standalone-dir"] ||
      process.env.OMNIROUTE_STANDALONE_DIR ||
      path.join(PROJECT_ROOT, ".build/next/standalone")
  );
  const launcherPath = path.join(standaloneDir, "dev", "run-standalone.mjs");
  const migrationsDir = path.join(standaloneDir, "migrations");
  if (
    !fs.existsSync(launcherPath) ||
    !fs.existsSync(path.join(standaloneDir, "server.js")) ||
    !fs.existsSync(path.join(standaloneDir, "server-ws.mjs")) ||
    !fs.existsSync(migrationsDir)
  ) {
    throw new Error(
      `built standalone is required; expected launcher, server.js, server-ws.mjs and migrations under ${standaloneDir}. This harness never builds it.`
    );
  }
  if (fs.existsSync("/run/omni-runtime-policy/required-v1.json")) {
    throw new Error("fetch-preload harness cannot run under the host's locked runtime policy");
  }
  const harnessCgroup = assertBoundedHarnessCgroup();
  // Fail before creating scratch or starting the candidate if the user manager
  // cannot create an independent, controller-visible app service.
  systemctlUser(["show-environment"]);
  const hostMemoryAvailableBytes = readHostMemoryAvailableBytes();
  if (hostMemoryAvailableBytes !== null && hostMemoryAvailableBytes < 8 * GIB) {
    throw new Error(
      `insufficient host MemAvailable for separate 3 GiB harness + 4 GiB app scopes: ${hostMemoryAvailableBytes} bytes`
    );
  }

  const { scratchParent, scratchRoot } = createPrivateScratchRoot();
  let preserveFailureScratch = false;
  process.once("exit", () => {
    if (preserveFailureScratch) return;
    const resolvedScratch = path.resolve(scratchRoot);
    if (
      path.dirname(resolvedScratch) === path.resolve(scratchParent) &&
      path.basename(resolvedScratch).startsWith("omni-standalone-ag-e2e-")
    ) {
      fs.rmSync(resolvedScratch, { recursive: true, force: true });
    }
  });
  const dataDir = path.join(scratchRoot, "data");
  const homeDir = path.join(scratchRoot, "home");
  const xdgDir = path.join(scratchRoot, "xdg");
  const auditDir = path.join(scratchRoot, "fetch-audit");
  const serviceEnvironmentFile = path.join(scratchRoot, "standalone.env");
  const serviceUnit = `omni-ag-e2e-${process.pid}-${randomBytes(4).toString("hex")}.service`;
  const preloadPath = path.join(
    PROJECT_ROOT,
    "tests/fixtures/antigravity-standalone-fetch-preload.mjs"
  );
  const availableDiskBefore = readAvailableBytes(scratchRoot);
  const expectedCallLogDisk = captureMode === "none" ? 0 : expectedRequests * 10 * MIB;
  const privateDiskBudget = captureMode === "private" ? 2 * GIB : 0;
  const minimumDisk = expectedCallLogDisk + privateDiskBudget + 512 * MIB;
  if (availableDiskBefore !== null && availableDiskBefore < minimumDisk) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    throw new Error(
      `insufficient scratch disk: need at least ${minimumDisk} bytes for configured caps, have ${availableDiskBefore}`
    );
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(xdgDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const tlsCertificate = createSyntheticTlsCertificate(scratchRoot);
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secretEnv = {
    API_KEY_SECRET: "synthetic-standalone-api-key-secret",
    JWT_SECRET: "synthetic-standalone-jwt-secret-v1",
    STORAGE_ENCRYPTION_KEY: "synthetic-standalone-storage-key",
    STORAGE_ENCRYPTION_KEY_VERSION: "v1",
  };
  const baseEnv = {
    ...secretEnv,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
    DATA_DIR: dataDir,
    XDG_CONFIG_HOME: xdgDir,
    HOME: homeDir,
    OMNIROUTE_MIGRATIONS_DIR: migrationsDir,
    OMNIROUTE_HOSTNAME: "127.0.0.1",
    PORT: String(port),
    NODE_ENV: "production",
    REQUIRE_API_KEY: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    DISABLE_SQLITE_AUTO_BACKUP: "true",
    OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "true",
    OMNI_COORDINATION_PROCESS_ROLE: "generation",
    PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS: "3600000",
    ANTIGRAVITY_CREDITS: "never",
    ENABLE_TLS_FINGERPRINT: "false",
    OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS: String(directDispatcherConnections),
    INITIAL_PASSWORD: "synthetic-standalone-admin-password",
    APP_LOG_TO_FILE: "false",
    APP_LOG_LEVEL: "error",
    ENABLE_REQUEST_LOGS: captureMode === "none" ? "false" : "true",
    CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS: "true",
    CALL_LOG_PIPELINE_MAX_SIZE_KB: "10240",
    CALL_LOG_PIPELINE_STREAM_CHUNK_MAX_SIZE_KB: "1024",
    CHAT_LOG_TEXT_LIMIT: "65536",
    CHAT_LOG_CLIENT_TEXT_LIMIT: "4194304",
    CHAT_LOG_MAX_BODY_KB: "10240",
    OMNI_DIAGNOSTIC_OVERFLOW_ENABLED: captureMode === "private" ? "true" : "false",
    OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES: "0",
    OMNI_DIAGNOSTIC_OVERFLOW_FILE_BYTES: "67108864",
    OMNI_DIAGNOSTIC_OVERFLOW_TOTAL_BYTES: String(2 * GIB),
    OMNI_DIAGNOSTIC_OVERFLOW_RETENTION_MS: "3600000",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    NODE_OPTIONS: `--max-old-space-size=4096 --import=${pathToFileURL(preloadPath).href}`,
    OMNIROUTE_MEMORY_MB: "4096",
    OMNIROUTE_TEST_FETCH_AUDIT_DIR: auditDir,
  };

  let mock = null;
  let tlsBridge = null;
  let server = null;
  let client = null;
  let appCgroupDir = null;
  let appCgroupSampler = null;
  let appCgroupBaseline = null;
  let appCgroupSnapshotBeforeStop = null;
  let appJournalTail = "";
  let appCgroupSampledPeakBytes = 0;
  let appCgroupSampleCount = 0;
  let appStopReason = null;
  let highPressureSamples = 0;
  let apiKey = null;
  let resultError = null;
  let dbApiKeyId = null;
  let currentStage = "preflight";
  let forcedExitTimer = null;
  const createdChildren = new Set();
  const onSignal = (signal) => {
    for (const child of createdChildren) child.kill(signal);
    if (process.env.OMNIROUTE_KEEP_STANDALONE_E2E_FAILURES === "1") preserveFailureScratch = true;
    forcedExitTimer ??= setTimeout(() => {
      if (server?.unit) stopStandaloneService(server.unit);
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      process.exit();
    }, 5_000);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    currentStage = "start_mock";
    console.error(`[standalone-antigravity-e2e] stage=${currentStage}`);
    mock = await startMock(
      path.join(PROJECT_ROOT, "tests/fixtures/antigravity-parallel-mock-upstream.mjs")
    );
    createdChildren.add(mock.child);
    currentStage = "start_tls_bridge";
    console.error(`[standalone-antigravity-e2e] stage=${currentStage}`);
    tlsBridge = await startSyntheticTlsBridge(mock.url, tlsCertificate);
    currentStage = "seed_database";
    console.error(`[standalone-antigravity-e2e] stage=${currentStage}`);
    const seedEnv = {
      ...baseEnv,
      NODE_ENV: "test",
      OMNIROUTE_MIGRATIONS_DIR: path.join(PROJECT_ROOT, "src/lib/db/migrations"),
    };
    const keys = await seedDatabase(dataDir, seedEnv, mock.url, captureMode);
    console.error(`[standalone-antigravity-e2e] stage=${currentStage}_complete`);
    apiKey = keys.apiKey;
    dbApiKeyId = apiKey.id;
    Object.assign(process.env, baseEnv);

    const serviceEnv = {
      ...baseEnv,
      NODE_EXTRA_CA_CERTS: tlsCertificate.certificatePath,
      OMNIROUTE_TEST_CLOUDCODE_BRIDGE_PORT: String(tlsBridge.port),
      OMNIROUTE_PROXY_ECHO_URL: `${mock.url}/__echo`,
    };
    writeSystemdEnvironmentFile(serviceEnvironmentFile, serviceEnv);
    server = { unit: serviceUnit, startOutput: "" };
    currentStage = "start_standalone";
    console.error(`[standalone-antigravity-e2e] stage=${currentStage}`);
    server.startOutput = startStandaloneService({
      unit: serviceUnit,
      standaloneDir,
      environmentFile: serviceEnvironmentFile,
      nodePath: process.execPath,
    });
    appCgroupDir = standaloneUnitCgroup(serviceUnit);
    appCgroupBaseline = snapshotCgroup(appCgroupDir);
    if (
      appCgroupBaseline.memoryCurrentBytes === null ||
      appCgroupBaseline.memoryPressure === null ||
      appCgroupBaseline.cpu === null ||
      appCgroupBaseline.memoryEvents === null
    ) {
      throw new Error("standalone cgroup memory/CPU/PSI controllers are not visible");
    }
    if (appCgroupBaseline.memoryCurrentBytes >= appCgroupBaseline.memoryHighBytes * 0.9) {
      throw new Error("standalone service baseline is already near its MemoryHigh limit");
    }
    appCgroupSampledPeakBytes = appCgroupBaseline.memoryCurrentBytes;
    appCgroupSampler = setInterval(() => {
      const sample = snapshotCgroup(appCgroupDir);
      appCgroupSampleCount++;
      if (sample.memoryCurrentBytes !== null) {
        appCgroupSampledPeakBytes = Math.max(appCgroupSampledPeakBytes, sample.memoryCurrentBytes);
      }
      const baseEvents = appCgroupBaseline?.memoryEvents ?? {};
      const currentEvents = sample.memoryEvents ?? {};
      if (
        (currentEvents.oom ?? 0) > (baseEvents.oom ?? 0) ||
        (currentEvents.oom_kill ?? 0) > (baseEvents.oom_kill ?? 0) ||
        (sample.memoryCurrentBytes ?? 0) >= 3.6 * GIB
      ) {
        if (!appStopReason) {
          appStopReason = "app reached 90% of memory.max or observed an OOM event";
          if (client) client.child.kill("SIGTERM");
          else stopStandaloneService(server?.unit);
        }
      }
      const avg10 = Number(/some avg10=([0-9.]+)/.exec(sample.memoryPressure || "")?.[1] ?? 0);
      highPressureSamples = avg10 >= 10 ? highPressureSamples + 1 : 0;
      if (highPressureSamples >= 3) {
        if (!appStopReason) {
          appStopReason = "app memory PSI some avg10 stayed above 10% for three samples";
          if (client) client.child.kill("SIGTERM");
          else stopStandaloneService(server?.unit);
        }
      }
    }, 500);
    appCgroupSampler.unref?.();
    currentStage = "wait_for_ready";
    console.error(`[standalone-antigravity-e2e] stage=${currentStage}`);
    await waitForReady(baseUrl, server, apiKey.key);
    console.error(`[standalone-antigravity-e2e] stage=${currentStage}_complete`);

    // Confirm the route enforces the configured key before the authenticated load.
    const unauthenticated = await harnessFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "antigravity/gemini-2.5-flash", messages: [] }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(unauthenticated.status, 401, "missing API key must be rejected");

    const clientEnv = {
      PATH: process.env.PATH,
      HOME: homeDir,
      TMPDIR: scratchRoot,
      ANTIGRAVITY_GATEWAY_URL: baseUrl,
      ANTIGRAVITY_TEST_API_KEY: apiKey.key,
      ANTIGRAVITY_CAPTURE_CONTEXT_BYTES: String(contextBytes),
      ANTIGRAVITY_CAPTURE_REQUEST_TIMEOUT_MS: String(requestTimeoutMs),
      ANTIGRAVITY_CAPTURE_SESSION_COUNTS: phases.join(","),
      ANTIGRAVITY_CAPTURE_MEMORY_BENCH: "1",
      NODE_OPTIONS: "",
    };
    client = spawnTracked(
      process.execPath,
      [path.join(PROJECT_ROOT, "tests/fixtures/antigravity-parallel-client.mjs")],
      { cwd: PROJECT_ROOT, env: clientEnv, stdio: ["ignore", "pipe", "pipe"] }
    );
    createdChildren.add(client.child);
    currentStage = "client_load";
    console.error(`[standalone-antigravity-e2e] stage=${currentStage}`);
    const clientClose = once(client.child, "close");
    const [clientCode, clientSignal] = await clientClose;
    assert.equal(clientCode, 0, `synthetic client failed (${clientSignal ?? clientCode})`);
    if (appStopReason) throw new Error(appStopReason);
    const clientOutputLines = client.stdout.split("\n").filter(Boolean);
    const clientResult = JSON.parse(clientOutputLines.at(-1) || "{}");
    assert.equal(clientResult.completedRequests, expectedRequests);

    const stats = await waitForMockStats(mock.url);
    assert.equal(stats.received, expectedRequests, "mock must receive every provider turn");
    assert.deepEqual(stats.errors, []);
    assert.equal(Object.keys(stats.identities).length, sessionCount);
    assert.equal(new Set(Object.values(stats.identities)).size, sessionCount);
    assert.equal(
      stats.profiles.length,
      Math.min(2, sessionCount),
      "mock must observe one Antigravity profile per synthetic conversation, up to both profiles"
    );
    assert.ok(
      stats.profiles.every((profile) => profile === "cli" || profile === "ide"),
      "mock observed an unexpected Antigravity profile"
    );
    if (sessionCount >= 2) assert.deepEqual(stats.profiles, ["cli", "ide"]);
    for (const phasesForSession of Object.values(stats.phases)) {
      assert.deepEqual(phasesForSession, ["tool", "answer"]);
    }
    const postCancelStats = await runCancellationProbe(baseUrl, mock.url, keys.cancelApiKey.key);
    assert.equal(postCancelStats.received, expectedRequests + 1);
    assert.equal(
      postCancelStats.providerResponsesCompleted,
      expectedRequests,
      "every normal synthetic upstream response must finish"
    );
    assert.equal(
      postCancelStats.providerResponsesAborted,
      1,
      "the cancellation probe must interrupt exactly one synthetic upstream response"
    );
    assert.equal(postCancelStats.providerResponsesActive, 0);
    assert.deepEqual(postCancelStats.errors, []);
    if (appStopReason) throw new Error(appStopReason);

    let artifactResult = { rows: 0, artifacts: 0, traces: 0 };
    if (captureMode !== "none") {
      const rows = await waitForCallLogs(dataDir, dbApiKeyId, expectedRequests);
      artifactResult = await inspectCapture({
        captureMode,
        rows,
        expectedRequests,
        expectedConversations: sessionCount,
        contextBytes,
      });
    }
    if (appStopReason) throw new Error(appStopReason);

    // Preload writes per-process audit summaries on exit. Stop the standalone
    // before reading them so its global-fetch and undici counts are final.
    if (appCgroupSampler) clearInterval(appCgroupSampler);
    appCgroupSampler = null;
    appCgroupSnapshotBeforeStop = snapshotCgroup(appCgroupDir);
    appCgroupSnapshotBeforeStop.sampledPeakBytes = appCgroupSampledPeakBytes;
    appCgroupSnapshotBeforeStop.sampleCount = appCgroupSampleCount;
    stopStandaloneService(server.unit);
    appJournalTail = readStandaloneJournal(server.unit);
    const audit = parseAuditFiles(auditDir);
    const bridgeStats = tlsBridge.snapshot();
    assert.equal(audit.blockedFetches, 0, "the app attempted a forbidden fetch");
    assert.equal(audit.blockedDnsLookups, 0, "the app attempted a forbidden DNS lookup");
    assert.equal(
      audit.blockedSockets,
      0,
      `the app attempted forbidden socket connections: ${JSON.stringify(audit.blockedSocketTargets)}`
    );
    assert.equal(audit.blockedDatagrams, 0, "the app attempted a forbidden UDP datagram");
    assert.ok(audit.preloadLocalTlsSelfChecks >= 1, "the loopback-only TLS fence was not checked");
    assert.equal(
      bridgeStats.providerRequests,
      expectedRequests + 1,
      "all synthetic Cloud Code stream requests must reach only the local TLS bridge"
    );
    assert.equal(bridgeStats.upstreamResponsesStarted, expectedRequests + 1);
    assert.equal(bridgeStats.upstreamResponsesCompleted, expectedRequests);
    assert.equal(bridgeStats.upstreamResponsesAborted, 1);
    assert.equal(bridgeStats.upstreamResponsesActive, 0);
    assert.equal(bridgeStats.clientResponsesCompleted, expectedRequests);
    assert.equal(bridgeStats.clientResponsesAborted, 1);
    assert.equal(bridgeStats.clientResponsesActive, 0);
    assert.equal(bridgeStats.unexpectedRequests, 0, "the app requested an unexpected bridge path");
    assert.equal(bridgeStats.errors, 0, "the local TLS bridge encountered a proxy error");

    console.log(
      JSON.stringify({
        harness: "standalone-antigravity-tool-roundtrip/v1",
        captureMode,
        phases,
        conversations: sessionCount,
        authenticatedRequests: expectedRequests,
        mockProviderRequests: stats.received,
        toolFollowups: Object.values(stats.phases).filter((value) => value[1] === "answer").length,
        profileCount: stats.profiles.length,
        selectedAccountConnections: artifactResult.accountConnections,
        accountConcurrencyCapVerified: false,
        callLogRows: artifactResult.rows,
        readyArtifacts: artifactResult.artifacts,
        completePrivateTraces: artifactResult.traces,
        contextBytesPerUserTurn: contextBytes,
        directDispatcherConnections,
        availableScratchBytesBefore: availableDiskBefore,
        hostMemoryAvailableBytes,
        fetchAudit: audit,
        syntheticTlsBridge: bridgeStats,
        appServiceUnit: server.unit,
        appCgroupBaseline,
        appCgroupBeforeStop: appCgroupSnapshotBeforeStop,
        harnessCgroup,
        appJournalTail: appJournalTail || "",
      })
    );
  } catch (error) {
    resultError = error;
    console.error(`[standalone-antigravity-e2e] failed_stage=${currentStage}`);
    console.error(
      `[standalone-antigravity-e2e] ${error instanceof Error ? error.message : String(error)}`
    );
    if (server?.startOutput) {
      console.error(`[standalone-antigravity-e2e] systemd start: ${server.startOutput}`);
    }
    if (client?.stdout)
      console.error(
        `[standalone-antigravity-e2e] client stdout tail:\n${trimTail(client.stdout, LOG_TAIL_LIMIT)}`
      );
    if (client?.stderr)
      console.error(
        `[standalone-antigravity-e2e] client stderr tail:\n${trimTail(client.stderr, LOG_TAIL_LIMIT)}`
      );
    if (mock?.output) console.error(`[standalone-antigravity-e2e] mock tail:\n${mock.output}`);
  } finally {
    if (forcedExitTimer) clearTimeout(forcedExitTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (appCgroupSampler) clearInterval(appCgroupSampler);
    await stopChild(client?.child);
    if (server?.unit) {
      if (!appCgroupSnapshotBeforeStop && appCgroupDir) {
        appCgroupSnapshotBeforeStop = snapshotCgroup(appCgroupDir);
        appCgroupSnapshotBeforeStop.sampledPeakBytes = appCgroupSampledPeakBytes;
        appCgroupSnapshotBeforeStop.sampleCount = appCgroupSampleCount;
      }
      stopStandaloneService(server.unit);
      appJournalTail = appJournalTail || readStandaloneJournal(server.unit);
      if (resultError) {
        console.error(`[standalone-antigravity-e2e] app service unit: ${server.unit}`);
        console.error(
          `[standalone-antigravity-e2e] app cgroup before stop: ${JSON.stringify(appCgroupSnapshotBeforeStop)}`
        );
        if (appJournalTail)
          console.error(`[standalone-antigravity-e2e] journal tail:\n${appJournalTail}`);
      }
    }
    if (resultError) {
      let fetchAudit = null;
      let bridgeStats = null;
      let mockSummary = null;
      try {
        fetchAudit = parseAuditFiles(auditDir);
      } catch {
        fetchAudit = { unavailable: true };
      }
      bridgeStats = tlsBridge?.snapshot() ?? null;
      if (mock?.url) {
        try {
          const stats = await waitForMockStats(mock.url);
          mockSummary = {
            received: stats.received,
            profiles: stats.profiles,
            egressProbes: stats.egressProbes,
            providerResponsesCompleted: stats.providerResponsesCompleted,
            providerResponsesAborted: stats.providerResponsesAborted,
            providerResponsesActive: stats.providerResponsesActive,
            providerRequestsAborted: stats.providerRequestsAborted,
            errorCount: stats.errors?.length ?? 0,
            errorSamples: (stats.errors ?? []).slice(0, 5),
          };
        } catch (error) {
          mockSummary = {
            unavailable: error instanceof Error ? error.message : String(error),
          };
        }
      }
      console.error(
        `[standalone-antigravity-e2e] post-shutdown network diagnostics: ${JSON.stringify({
          fetchAudit,
          blockedReasonAggregate: fetchAudit?.blockedSocketReasons ?? null,
          blockedSocketTargets: fetchAudit?.blockedSocketTargets ?? [],
          syntheticTlsBridge: bridgeStats,
          mock: mockSummary,
        })}`
      );
    }
    await tlsBridge?.close();
    await stopChild(mock?.child);
    try {
      const core = await import("../../src/lib/db/core.ts");
      core.closeDbInstance({ checkpointMode: null });
    } catch {
      // The source seeder may not have initialized if the build was absent.
    }
    const resolvedScratch = path.resolve(scratchRoot);
    if (
      resultError &&
      process.env.OMNIROUTE_KEEP_STANDALONE_E2E_FAILURES === "1" &&
      path.dirname(resolvedScratch) === path.resolve(scratchParent) &&
      path.basename(resolvedScratch).startsWith("omni-standalone-ag-e2e-")
    ) {
      preserveFailureScratch = true;
      console.error(
        `[standalone-antigravity-e2e] preserved failed-run scratch: ${resolvedScratch}`
      );
    } else {
      if (
        path.dirname(resolvedScratch) === path.resolve(scratchParent) &&
        path.basename(resolvedScratch).startsWith("omni-standalone-ag-e2e-")
      ) {
        fs.rmSync(resolvedScratch, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
      console.log(
        "[standalone-antigravity-e2e] removed this run's temporary data, logs and audits"
      );
    }
  }

  if (resultError) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[standalone-antigravity-e2e] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
