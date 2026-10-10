import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-skill-cancel-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { executeServerOwned } = await import("../../src/lib/skills/interception.ts");
const { runServerOwnedToolLoop } = await import("../../src/lib/skills/serverOwnedToolLoop.ts");
const { OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME } =
  await import("../../open-sse/services/webSearchFallback.ts");
const { OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME } =
  await import("../../open-sse/services/webFetchInterception.ts");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string) {
  await providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-cancel-test`,
    apiKey: "test-api-key",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

function makeInitialLeg(
  toolName: string,
  arguments_: Record<string, unknown>,
  format: "chat" | "responses" = "chat"
) {
  const now = new Date().toISOString();
  const toolCall =
    format === "responses"
      ? {
          id: "call-skill-cancel",
          type: "function_call",
          call_id: "call-skill-cancel",
          name: toolName,
          arguments: JSON.stringify(arguments_),
        }
      : {
          id: "call-skill-cancel",
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(arguments_) },
        };
  return {
    kind: "ok" as const,
    response:
      format === "responses"
        ? { id: "resp-skill-cancel", output: [toolCall] }
        : {
            id: "chatcmpl-skill-cancel",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [toolCall],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
    responseForMemoryExtraction: {},
    providerBody: {},
    providerRequest: {},
    usage: null,
    responsePayloadFormat: "openai",
    looksLikeSSE: false,
    connectionId: "chat-connection",
    headers: new Headers(),
    receipt: {
      index: 0,
      connectionId: "chat-connection",
      provider: "openai",
      model: "gpt-test",
      startedAt: now,
      endedAt: now,
      latencyMs: 1,
      httpStatus: 200,
      errorType: null,
      usage: null,
      serviceTier: null,
      computedCostUsd: null,
      toolCalls: [{ id: "call-skill-cancel", name: toolName }],
      termination: "completed",
      clientVisible: true,
    },
  };
}

async function runBuiltinToolUntilAbort(input: {
  toolName: string;
  args: Record<string, unknown>;
  caller: AbortController;
  format?: "chat" | "responses";
}) {
  const initialLeg = makeInitialLeg(input.toolName, input.args, input.format);
  let followUpCalls = 0;
  const loopPromise = runServerOwnedToolLoop({
    initialLeg,
    sourceBody: { model: "gpt-test", messages: [{ role: "user", content: "use the tool" }] },
    sourceFormat: "openai",
    skillsModelId: "gpt-test",
    executionContext: {
      apiKeyId: "skill-cancel-key",
      sessionId: "skill-cancel-session",
      requestId: "skill-cancel-request",
      builtinToolNames: [input.toolName],
      provider: "openai",
      model: "gpt-test",
    },
    abortSignal: input.caller.signal,
    executeServerOwned,
    resumeUpstream: async () => {
      followUpCalls++;
      return initialLeg;
    },
    deadlineAtMs: performance.now() + 120_000,
  });
  return { loopPromise, getFollowUpCalls: () => followUpCalls };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

async function waitForFetchStart(promise: Promise<AbortSignal>, tool: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${tool} did not reach upstream fetch`)),
          5_000
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("chat-owned web_search receives request abort, stops upstream, and returns client_abort", async () => {
  await seedConnection("brave-search");
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  const started = deferred<AbortSignal>();

  globalThis.fetch = async (_url, init = {}) => {
    const signal = (init as RequestInit).signal as AbortSignal;
    started.resolve(signal);
    return waitForAbort(signal);
  };

  try {
    const { loopPromise, getFollowUpCalls } = await runBuiltinToolUntilAbort({
      toolName: OMNIROUTE_WEB_SEARCH_FALLBACK_TOOL_NAME,
      args: { query: "tool search cancellation", provider: "brave-search" },
      caller,
    });

    const upstreamSignal = await waitForFetchStart(started.promise, "web_search");
    caller.abort(new Error("chat client disconnected"));

    const result = await loopPromise;
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(result.kind, "error");
    assert.equal(result.termination, "client_abort");
    assert.equal(result.errorResult?.status, 499);
    assert.equal(getFollowUpCalls(), 0, "an aborted tool must not resume/retry the model provider");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat-owned web_fetch receives request abort, stops upstream, and returns client_abort", async () => {
  await seedConnection("firecrawl");
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  const started = deferred<AbortSignal>();

  globalThis.fetch = async (_url, init = {}) => {
    const signal = (init as RequestInit).signal as AbortSignal;
    started.resolve(signal);
    return waitForAbort(signal);
  };

  try {
    const { loopPromise, getFollowUpCalls } = await runBuiltinToolUntilAbort({
      toolName: OMNIROUTE_WEB_FETCH_FALLBACK_TOOL_NAME,
      args: { url: "https://example.com/article", provider: "firecrawl" },
      caller,
      format: "responses",
    });

    const upstreamSignal = await waitForFetchStart(started.promise, "web_fetch");
    caller.abort(new Error("chat client disconnected"));

    const result = await loopPromise;
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(result.kind, "error");
    assert.equal(result.termination, "client_abort");
    assert.equal(result.errorResult?.status, 499);
    assert.equal(getFollowUpCalls(), 0, "an aborted tool must not resume/retry the model provider");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
