#!/usr/bin/env node
/**
 * Full HTTP-path load check for separate chat conversations with an assistant
 * tool call and tool-result round trip. A localhost fake OpenAI upstream removes
 * provider latency, credentials, rate limits, and egress. This is a dev-server /
 * middleware test, not a production image or provider-capacity benchmark.
 *
 * Run on an idle test host in a bounded user scope:
 *   systemd-run --user --scope --property=MemoryMax=6G --property=CPUQuota=200% \
 *     --property=Nice=10 npm run bench:next-http-tool-roundtrip
 *   npm run bench:next-http-tool-roundtrip -- --rate-limit=unlimited
 *
 * The benchmark owns a temporary DATA_DIR and Next dist directory and removes
 * them when it exits. Nothing is written to the live database or provider.
 */

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { readFileSync, statfsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) {
      throw new Error(`Invalid benchmark option: ${argument}`);
    }
    return [argument.slice(2, separator), argument.slice(separator + 1)];
  })
);
const unknownOptions = Object.keys(options).filter(
  (name) => !["phases", "message-bytes", "rate-limit"].includes(name)
);
if (unknownOptions.length > 0) {
  throw new Error(`Unknown benchmark option(s): ${unknownOptions.join(", ")}`);
}
const PHASES = (options.phases || "1,30,70,100")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
if (PHASES.length === 0) throw new Error("At least one positive --phases entry is required");
const MESSAGE_BYTES = Math.max(1024, Number(options["message-bytes"]) || 4096);
const STARTUP_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 90_000;
const CALL_LOG_DRAIN_TIMEOUT_MS = 30_000;
const LOG_TAIL_LIMIT = 80_000;
if (options["rate-limit"] && !["default", "unlimited"].includes(options["rate-limit"])) {
  throw new Error("--rate-limit must be default or unlimited");
}
const RATE_LIMIT_MODE =
  options["rate-limit"] === "unlimited"
    ? "API-key auto-limiter disabled"
    : "default queue settings";

function trimTail(current, chunk) {
  return (current + chunk).slice(-LOG_TAIL_LIMIT);
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(
    sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)].toFixed(2)
  );
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

function cgroupDirectory() {
  try {
    const row = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((line) => line.startsWith("0::"));
    if (!row) return null;
    return path.join("/sys/fs/cgroup", row.slice(3).replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function readCgroupInteger(directory, name) {
  if (!directory) return null;
  try {
    const value = readFileSync(path.join(directory, name), "utf8").trim();
    return value === "max" ? null : Number(value);
  } catch {
    return null;
  }
}

function processVmHwm(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmHWM:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function rootAvailableBytes() {
  try {
    const stats = statfsSync("/");
    return typeof stats.bavail === "number" && typeof stats.bsize === "number"
      ? stats.bavail * stats.bsize
      : null;
  } catch {
    return null;
  }
}

function responseJson(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function mockCompletion(body, id) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const isToolResult = messages.some((message) => message?.role === "tool");
  const firstTool = Array.isArray(body.tools) ? body.tools[0]?.function : null;
  const useTool = Boolean(firstTool && !isToolResult);
  return {
    id: `chatcmpl-local-${id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === "string" ? body.model : "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: useTool
          ? {
              role: "assistant",
              tool_calls: [
                {
                  id: `call-local-${id}`,
                  type: "function",
                  function: {
                    name: firstTool.name || "lookup",
                    arguments: JSON.stringify({ query: "mocked local result" }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "mocked tool round-trip complete" },
        finish_reason: useTool ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 64, completion_tokens: 8, total_tokens: 72 },
  };
}

function sseCompletion(body, id) {
  const completion = mockCompletion(body, id);
  const message = completion.choices[0].message;
  const data = [];
  if (message.tool_calls) {
    data.push({
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", tool_calls: message.tool_calls },
          finish_reason: null,
        },
      ],
    });
    data.push({
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
  } else {
    const words = message.content.split(/(?<=\s)/);
    for (const word of words) {
      data.push({
        id: completion.id,
        object: "chat.completion.chunk",
        created: completion.created,
        model: completion.model,
        choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
      });
    }
    data.push({
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  }
  data.push({
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: [],
    usage: completion.usage,
  });
  return data;
}

// Pin the scratch root directly to the host /tmp mount. Do not inherit a
// workspace TMPDIR: generated Turbopack chunks are large and should never land
// under this checkout's blue/tmp directory.
const tempRoot = await mkdtemp(path.join("/tmp", "omni-next-http-tool-roundtrip-"));
const dataDir = path.join(tempRoot, "data");
const tempName = path.basename(tempRoot);
// Next's `distDir` is resolved relative to the project root, even if an
// absolute path is supplied. Keep only this run's build beneath blue/tmp so
// its exact workspace directory can be reclaimed after the server exits.
const projectDistRoot = path.join(PROJECT_ROOT, "tmp", tempName);
const distDir = path.join("tmp", tempName, "next-dist");
const xdgConfigDir = path.join(tempRoot, "xdg");
await Promise.all([
  mkdir(dataDir, { recursive: true }),
  mkdir(xdgConfigDir, { recursive: true }),
  mkdir(projectDistRoot, { recursive: true }),
]);

const availableDiskBefore = rootAvailableBytes();
const cgroupDir = cgroupDirectory();
const cgroupMemoryMax = readCgroupInteger(cgroupDir, "memory.max");
const cgroupMemoryStart = readCgroupInteger(cgroupDir, "memory.current");
let cgroupSamplePeak = cgroupMemoryStart;

const env = {
  ...process.env,
  DATA_DIR: dataDir,
  NEXT_DIST_DIR: distDir,
  XDG_CONFIG_HOME: xdgConfigDir,
  NODE_ENV: "development",
  NODE_OPTIONS: "--max-old-space-size=4096",
  NEXT_TELEMETRY_DISABLED: "1",
  DISABLE_SQLITE_AUTO_BACKUP: "true",
  OMNIROUTE_DISABLE_BACKGROUND_SERVICES: "true",
  OMNI_COORDINATION_PROCESS_ROLE: "generation",
  OMNIROUTE_E2E_BOOTSTRAP_MODE: "open",
  INITIAL_PASSWORD: "",
  OMNIROUTE_E2E_PASSWORD: "",
  OMNIROUTE_API_KEY: "",
  API_KEY_SECRET: "omniroute-local-http-e2e-api-key-secret",
  JWT_SECRET: "omniroute-local-http-e2e-jwt-secret",
  STORAGE_ENCRYPTION_KEY: "ab".repeat(32),
  PORT: String(await findFreePort()),
  HOST: "127.0.0.1",
  HOSTNAME: "127.0.0.1",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  ALL_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  all_proxy: "",
};
// The harness also seeds settings and provider credentials in its own process
// before spawning Next, so both processes must resolve the same isolated paths.
Object.assign(process.env, env);
if (RATE_LIMIT_MODE === "API-key auto-limiter disabled") {
  process.env.RATE_LIMIT_AUTO_ENABLE = "false";
  env.RATE_LIMIT_AUTO_ENABLE = "false";
} else {
  delete process.env.RATE_LIMIT_AUTO_ENABLE;
  delete env.RATE_LIMIT_AUTO_ENABLE;
}

const appBaseUrl = `http://127.0.0.1:${env.PORT}`;
const mockRequestModels = [];
let mockRequestCount = 0;
let mockToolFollowups = 0;
let mockServer;
let nextServer;
let nextLogTail = "";
let cgroupMonitor;
let coreDb;
let rootFailure = null;

async function startMockUpstream() {
  mockServer = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (request.url !== "/v1/chat/completions") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const requestId = ++mockRequestCount;
        mockRequestModels.push(typeof body.model === "string" ? body.model : "");
        if (
          Array.isArray(body.messages) &&
          body.messages.some((message) => message?.role === "tool")
        ) {
          mockToolFollowups++;
        }
        if (body.stream === true) {
          response.statusCode = 200;
          response.setHeader("content-type", "text/event-stream; charset=utf-8");
          response.setHeader("cache-control", "no-cache");
          response.setHeader("connection", "keep-alive");
          for (const event of sseCompletion(body, requestId)) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end("data: [DONE]\n\n");
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(mockCompletion(body, requestId)));
      } catch (error) {
        response.statusCode = 400;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", resolve);
  });
  const address = mockServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) throw new Error("Could not allocate mock OpenAI upstream port");
  return `http://127.0.0.1:${port}/v1`;
}

async function waitForNextReady() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let nextProgressAt = Date.now() + 15_000;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    if (nextServer.exitCode !== null) {
      throw new Error(`Next server exited with ${nextServer.exitCode}.\n${nextLogTail}`);
    }
    try {
      const health = await new Promise((resolve, reject) => {
        const request = httpRequest(`${appBaseUrl}/api/health`, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () =>
            resolve({
              status: response.statusCode || 0,
              body: Buffer.concat(chunks).toString("utf8"),
            })
          );
        });
        request.setTimeout(2_000, () => request.destroy(new Error("health request timed out")));
        request.once("error", reject);
        request.end();
      });
      if (health.status === 200) return;
      lastError = `HTTP ${health.status}: ${health.body.slice(0, 300)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= nextProgressAt) {
      console.log(`[bench-next-http] still waiting for Next startup (${lastError})`);
      nextProgressAt = Date.now() + 15_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Next at ${appBaseUrl}: ${lastError}.\n${nextLogTail}`);
}

async function startNext() {
  nextServer = spawn(process.execPath, ["scripts/dev/run-next.mjs", "dev"], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => {
    nextLogTail = (nextLogTail + chunk.toString()).slice(-LOG_TAIL_LIMIT);
    process.stdout.write(chunk);
  };
  nextServer.stdout.on("data", append);
  nextServer.stderr.on("data", append);
  await waitForNextReady();
}

async function postChat(payload, sessionId) {
  const startedAt = performance.now();
  const response = await fetch(`${appBaseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-session-id": sessionId,
      "x-codex-session-id": sessionId,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const firstResponseMs = performance.now() - startedAt;
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1200);
    throw new Error(`HTTP ${response.status} for ${sessionId}: ${body}`);
  }
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const body = (await response.text()).slice(0, 1200);
    throw new Error(`Expected streamed response for ${sessionId}; got ${contentType}: ${body}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error(`No response stream for ${sessionId}`);
  const decoder = new TextDecoder();
  let pending = "";
  let firstBodyByteMs = null;
  const events = [];
  let reachedDone = false;
  while (!reachedDone) {
    const result = await reader.read();
    if (result.done) break;
    if (firstBodyByteMs === null) firstBodyByteMs = performance.now() - startedAt;
    pending += decoder.decode(result.value, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const frame = pending.slice(0, boundary).replace(/\r/g, "");
      pending = pending.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        reachedDone = true;
        break;
      }
      try {
        events.push(JSON.parse(data));
      } catch {
        throw new Error(`Invalid SSE frame for ${sessionId}: ${data.slice(0, 300)}`);
      }
    }
  }
  await reader.cancel().catch(() => {});
  if (!reachedDone) throw new Error(`Stream ended without [DONE] for ${sessionId}`);
  return {
    events,
    responseMs: performance.now() - startedAt,
    firstBodyByteMs,
  };
}

function collectToolCalls(events) {
  const calls = new Map();
  for (const event of events) {
    for (const choice of event.choices || []) {
      for (const patch of choice.delta?.tool_calls || []) {
        const index = Number(patch.index || 0);
        const current = calls.get(index) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (patch.id) current.id += patch.id;
        if (patch.type) current.type = patch.type;
        if (patch.function?.name) current.function.name += patch.function.name;
        if (patch.function?.arguments) current.function.arguments += patch.function.arguments;
        calls.set(index, current);
      }
    }
  }
  return [...calls.values()];
}

function collectText(events) {
  return events
    .flatMap((event) => event.choices || [])
    .map((choice) => choice.delta?.content || "")
    .join("");
}

function makeToolDefinition() {
  return {
    type: "function",
    function: {
      name: "lookup",
      description: "Return a synthetic result from the local benchmark provider.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  };
}

function makeHistory(sessionId) {
  const filler = "x".repeat(MESSAGE_BYTES);
  return [
    { role: "user", content: `Historical request 1 (${sessionId})\n${filler}` },
    { role: "assistant", content: `Historical response 1 (${sessionId})\n${filler}` },
    { role: "user", content: `Historical request 2 (${sessionId})\n${filler}` },
    { role: "assistant", content: `Historical response 2 (${sessionId})\n${filler}` },
    { role: "user", content: `Run lookup for ${sessionId}` },
  ];
}

async function runConversation(sessionId) {
  const messages = makeHistory(sessionId);
  const tools = [makeToolDefinition()];
  const first = await postChat(
    {
      model: "openai/gpt-4o-mini",
      messages,
      tools,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
    },
    sessionId
  );
  const toolCall = collectToolCalls(first.events)[0];
  if (!toolCall?.id || !toolCall.function?.name) {
    throw new Error(
      `Expected a streamed tool call for ${sessionId}: ${JSON.stringify(first.events).slice(0, 800)}`
    );
  }

  const second = await postChat(
    {
      model: "openai/gpt-4o-mini",
      messages: [
        ...messages,
        { role: "assistant", tool_calls: [toolCall] },
        {
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify({ result: "mocked local tool output" }),
        },
      ],
      tools,
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
    },
    sessionId
  );
  const finalText = collectText(second.events);
  if (!finalText.includes("mocked tool round-trip complete")) {
    throw new Error(
      `Expected final streamed text for ${sessionId}: ${JSON.stringify(second.events).slice(0, 800)}`
    );
  }

  return {
    firstResponseMs: first.responseMs,
    secondResponseMs: second.responseMs,
    firstBodyByteMs: first.firstBodyByteMs,
    secondBodyByteMs: second.firstBodyByteMs,
  };
}

async function countCallLogs() {
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const db = new Database(path.join(dataDir, "storage.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return Number(db.prepare("SELECT COUNT(*) AS count FROM call_logs").get()?.count || 0);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function countArtifacts() {
  let count = 0;
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filePath);
      else if (entry.isFile() && /\.(?:json|gz)$/.test(entry.name)) count++;
    }
  }
  await walk(path.join(dataDir, "call_logs"));
  return count;
}

async function waitForCallLogs(expected) {
  const deadline = Date.now() + CALL_LOG_DRAIN_TIMEOUT_MS;
  let rows = await countCallLogs();
  let artifacts = await countArtifacts();
  while (rows !== null && rows < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    rows = await countCallLogs();
    artifacts = await countArtifacts();
  }
  return { rows, artifacts };
}

async function stopNext() {
  if (!nextServer || nextServer.exitCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      nextServer?.kill("SIGKILL");
      resolve();
    }, 10_000);
    nextServer.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    nextServer.kill("SIGTERM");
  });
}

let result;
let failure = null;
const completedPhases = [];
try {
  const upstreamBaseUrl = await startMockUpstream();
  const core = await import(pathToFileURL(path.join(PROJECT_ROOT, "src/lib/db/core.ts")).href);
  coreDb = core;
  const providers = await import(
    pathToFileURL(path.join(PROJECT_ROOT, "src/lib/db/providers.ts")).href
  );
  const settings = await import(
    pathToFileURL(path.join(PROJECT_ROOT, "src/lib/db/settings.ts")).href
  );
  await settings.updateSettings({ requireLogin: false });
  const connection = await providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "local-next-e2e-mock-provider",
    apiKey: "sk-local-http-e2e-not-a-real-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: upstreamBaseUrl },
  });
  const storedBaseUrl = connection.providerSpecificData?.baseUrl;
  if (storedBaseUrl !== upstreamBaseUrl) {
    throw new Error(`Mock provider base URL was not persisted: ${String(storedBaseUrl)}`);
  }
  core.resetDbInstance();

  if (cgroupDir) {
    cgroupMonitor = setInterval(() => {
      const current = readCgroupInteger(cgroupDir, "memory.current");
      if (current !== null && (cgroupSamplePeak === null || current > cgroupSamplePeak)) {
        cgroupSamplePeak = current;
      }
    }, 250);
  }

  nextServer = spawn(process.execPath, ["scripts/dev/run-next.mjs", "dev"], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appendNextLogs = (chunk) => {
    nextLogTail = trimTail(nextLogTail, chunk.toString());
  };
  nextServer.stdout.on("data", appendNextLogs);
  nextServer.stderr.on("data", appendNextLogs);

  console.log(`[bench-next-http] starting isolated Next dev server at ${appBaseUrl}`);
  await waitForNextReady();
  console.log(
    `[bench-next-http] Next is ready; mock OpenAI upstream is ${upstreamBaseUrl}; rate limiter mode=${RATE_LIMIT_MODE}`
  );

  const warmup = await postChat(
    {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "warmup" }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 16,
    },
    "bench-warmup"
  );
  if (!collectText(warmup.events).includes("mocked tool round-trip complete")) {
    throw new Error(`Warmup failed: ${JSON.stringify(warmup.events).slice(0, 800)}`);
  }

  const conversationDurations = [];
  const firstByteDurations = [];
  for (const sessionCount of PHASES) {
    const startedAt = performance.now();
    const results = await Promise.all(
      Array.from({ length: sessionCount }, (_, index) =>
        runConversation(`bench-${sessionCount}-${index}`)
      )
    );
    const wallMs = performance.now() - startedAt;
    const roundTrips = results.map((item) => item.firstResponseMs + item.secondResponseMs);
    const firstBytes = results.flatMap((item) => [item.firstBodyByteMs, item.secondBodyByteMs]);
    completedPhases.push({
      conversations: sessionCount,
      completed: results.length,
      chatRequests: results.length * 2,
      wallMs: Number(wallMs.toFixed(2)),
      conversationsPerSecond: Number((results.length / (wallMs / 1000)).toFixed(2)),
      roundTripMsP50: percentile(roundTrips, 0.5),
      roundTripMsP95: percentile(roundTrips, 0.95),
      streamFirstBodyByteMsP50: percentile(firstBytes, 0.5),
      streamFirstBodyByteMsP95: percentile(firstBytes, 0.95),
    });
    conversationDurations.push(...roundTrips);
    firstByteDurations.push(...firstBytes);
    console.log(
      `[bench-next-http] ${sessionCount} conversations: ${results.length}/${sessionCount} completed in ${wallMs.toFixed(0)}ms`
    );
  }

  const expectedRequests = 1 + PHASES.reduce((total, count) => total + count * 2, 0);
  const expectedToolFollowups = PHASES.reduce((total, count) => total + count, 0);
  const callLogs = await waitForCallLogs(expectedRequests);
  result = {
    benchmark: "next-http-openai-tool-roundtrip/v1",
    runtime: process.version,
    mode: "Next development server with Turbopack, local HTTP mock provider, isolated DATA_DIR",
    rateLimitMode: RATE_LIMIT_MODE,
    scope: {
      cgroupMemoryMaxBytes: cgroupMemoryMax,
      cgroupCurrentBeforeBytes: cgroupMemoryStart,
      cgroupSampledPeakBytes: cgroupSamplePeak,
      cgroupKernelPeakBytes: readCgroupInteger(cgroupDir, "memory.peak"),
      nodeMaxOldSpaceMiB: 4096,
      messageBytesPerHistoricalTurn: MESSAGE_BYTES,
    },
    phases: completedPhases,
    aggregate: {
      conversations: PHASES.reduce((sum, count) => sum + count, 0),
      chatRequests: PHASES.reduce((sum, count) => sum + count * 2, 0),
      toolRoundTripMsP50: percentile(conversationDurations, 0.5),
      toolRoundTripMsP95: percentile(conversationDurations, 0.95),
      streamFirstBodyByteMsP50: percentile(firstByteDurations, 0.5),
      streamFirstBodyByteMsP95: percentile(firstByteDurations, 0.95),
      mockProviderRequestsIncludingWarmup: mockRequestCount,
      mockToolFollowups: mockToolFollowups,
      callLogRowsIncludingWarmup: callLogs.rows,
      expectedCallLogRowsIncludingWarmup: expectedRequests,
      capturedArtifactFiles: callLogs.artifacts,
    },
    rootDiskAvailableBeforeBytes: availableDiskBefore,
  };

  if (mockRequestCount !== expectedRequests) {
    throw new Error(`Expected ${expectedRequests} mock requests, received ${mockRequestCount}`);
  }
  if (mockToolFollowups !== expectedToolFollowups) {
    throw new Error(
      `Expected ${expectedToolFollowups} tool follow-up requests, got ${mockToolFollowups}`
    );
  }
  if (callLogs.rows !== expectedRequests) {
    throw new Error(`Expected ${expectedRequests} call-log rows, got ${callLogs.rows}`);
  }
  if (callLogs.artifacts !== expectedRequests) {
    throw new Error(`Expected ${expectedRequests} call-log artifacts, got ${callLogs.artifacts}`);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  failure = error;
  console.error(
    `[bench-next-http] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`
  );
  if (completedPhases.length > 0) {
    console.log(
      JSON.stringify(
        {
          benchmark: "next-http-openai-tool-roundtrip/v1",
          partial: true,
          rateLimitMode: RATE_LIMIT_MODE,
          completedPhases,
          mockProviderRequests: mockRequestCount,
        },
        null,
        2
      )
    );
  }
  if (nextLogTail) console.error(`[bench-next-http] Next server log tail:\n${nextLogTail}`);
} finally {
  if (cgroupMonitor) clearInterval(cgroupMonitor);
  await stopNext();
  if (mockServer) await new Promise((resolve) => mockServer.close(() => resolve()));
  try {
    coreDb?.resetDbInstance?.();
  } catch {}
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(projectDistRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log("[bench-next-http] removed isolated data, dist, and XDG directories");
}

if (failure) process.exitCode = 1;
