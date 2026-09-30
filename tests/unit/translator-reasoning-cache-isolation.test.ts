import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousDataDir = process.env.DATA_DIR;
const previousApiKeySecret = process.env.API_KEY_SECRET;
const dataDir = mkdtempSync(join(tmpdir(), "omniroute-translator-replay-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "fabricated-translator-replay-test-secret";

import type { ReasoningCacheContext } from "../../open-sse/services/reasoningCacheContext.ts";

const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { prepareClaudeRequest, NON_ANTHROPIC_THINKING_PLACEHOLDER } =
  await import("../../open-sse/translator/helpers/claudeHelper.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const {
  cacheReasoning,
  cacheReasoningByKey,
  buildAssistantMessageCacheKey,
  clearReasoningCacheAll,
} = await import("../../open-sse/services/reasoningCache.ts");
const { createReasoningCacheKeyContext, createLocalReasoningCacheContext } =
  await import("../../open-sse/services/reasoningCacheContext.ts");
const { getReasoningCacheEntries, setReasoningCache } =
  await import("../../src/lib/db/reasoningCache.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

const contextA = createReasoningCacheKeyContext("fabricated-validated-key-A");
const contextB = createReasoningCacheKeyContext("fabricated-validated-key-B");
const localContext = createLocalReasoningCacheContext();
assert.ok(contextA);
assert.ok(contextB);
assert.ok(localContext);

const REASONING_A = "Private reasoning for principal A";
const REASONING_B = "Private reasoning for principal B";
const REASONING_LOCAL = "Private reasoning for local requests";
const SHARED_ID = "call_shared_by_all_principals";
const lanes = [
  "chat",
  "responses",
  "responses-to-chat",
  "claude",
  "claude-redacted",
  "kimi",
] as const;
type Lane = (typeof lanes)[number];
type TranslateOptions = NonNullable<Parameters<typeof translateRequest>[8]>;

test.beforeEach(() => {
  clearReasoningCacheAll();
});

test.after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousApiKeySecret === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = previousApiKeySecret;
});

function chatBody(id = SHARED_ID) {
  return {
    messages: [
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: id, content: "file contents" },
    ],
  };
}

function claudeBody(id = SHARED_ID, redacted = false) {
  return {
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: [
      { role: "user", content: [{ type: "text", text: "Read the file" }] },
      {
        role: "assistant",
        content: [
          ...(redacted ? [{ type: "redacted_thinking", data: "untrusted-client-blob" }] : []),
          { type: "tool_use", id, name: "read", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "file contents" }],
      },
    ],
  };
}

function translateLane(lane: Lane, id = SHARED_ID, options?: TranslateOptions) {
  if (lane === "claude" || lane === "claude-redacted" || lane === "kimi") {
    return translateRequest(
      FORMATS.CLAUDE,
      FORMATS.CLAUDE,
      lane === "kimi" ? "k3-256k" : "glm-replay-test-thinking",
      claudeBody(id, lane === "claude-redacted"),
      false,
      null,
      lane === "kimi" ? "kimi-coding-apikey" : "glmt",
      null,
      options
    );
  }
  if (lane === "responses-to-chat") {
    return translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "deepseek-v4-flash",
      {
        input: [
          { type: "message", role: "user", content: "Read the file" },
          { type: "function_call", call_id: id, name: "read", arguments: "{}" },
          { type: "function_call_output", call_id: id, output: "file contents" },
        ],
      },
      false,
      null,
      "deepseek",
      null,
      options
    );
  }
  return translateRequest(
    FORMATS.OPENAI,
    lane === "responses" ? FORMATS.OPENAI_RESPONSES : FORMATS.OPENAI,
    "deepseek-v4-flash",
    chatBody(id),
    false,
    null,
    "deepseek",
    null,
    options
  );
}

function assertContainsReasoning(body: unknown, text: string): void {
  assert.ok(JSON.stringify(body).includes(text), `outgoing body must contain ${text}`);
}

function assertExcludesReasoning(body: unknown, ...texts: string[]): void {
  for (const text of texts) {
    assert.equal(
      JSON.stringify(body).includes(text),
      false,
      `outgoing body must not contain ${text}`
    );
  }
}

for (const lane of lanes) {
  test(`${lane}: identical tool IDs replay only the authenticated principal's reasoning`, () => {
    // Provider, model, session and tool ID are identical. Only trusted context changes.
    const options = { reasoningCacheScope: "shared-client-controlled-session" };
    cacheReasoning(SHARED_ID, "deepseek", "deepseek-v4-flash", REASONING_A, contextA);
    assertContainsReasoning(
      translateLane(lane, SHARED_ID, { ...options, reasoningCacheContext: contextA }),
      REASONING_A
    );
    assertExcludesReasoning(
      translateLane(lane, SHARED_ID, { ...options, reasoningCacheContext: contextB }),
      REASONING_A
    );

    cacheReasoning(SHARED_ID, "deepseek", "deepseek-v4-flash", REASONING_B, contextB);
    const outgoingA = translateLane(lane, SHARED_ID, {
      ...options,
      reasoningCacheContext: contextA,
    });
    const outgoingB = translateLane(lane, SHARED_ID, {
      ...options,
      reasoningCacheContext: contextB,
    });
    assertContainsReasoning(outgoingA, REASONING_A);
    assertExcludesReasoning(outgoingA, REASONING_B);
    assertContainsReasoning(outgoingB, REASONING_B);
    assertExcludesReasoning(outgoingB, REASONING_A);
  });

  test(`${lane}: missing, null or forged context never becomes the local principal`, () => {
    cacheReasoning(SHARED_ID, "deepseek", "deepseek-v4-flash", REASONING_A, contextA);
    cacheReasoning(SHARED_ID, "deepseek", "deepseek-v4-flash", REASONING_LOCAL, localContext);
    assertContainsReasoning(
      translateLane(lane, SHARED_ID, { reasoningCacheContext: localContext }),
      REASONING_LOCAL
    );
    const forgedContexts: unknown[] = [
      null,
      { ...contextA },
      JSON.parse(JSON.stringify(contextA)),
      { kind: "local" },
      { principal: contextA, session: "shared-client-controlled-session" },
    ];
    assertExcludesReasoning(translateLane(lane), REASONING_A, REASONING_LOCAL);
    assertExcludesReasoning(
      translateLane(lane, SHARED_ID, { skipReasoningReplay: true }),
      REASONING_A,
      REASONING_LOCAL
    );
    for (const forged of forgedContexts) {
      assertExcludesReasoning(
        translateLane(lane, SHARED_ID, {
          reasoningCacheContext: forged as ReasoningCacheContext | null,
        }),
        REASONING_A,
        REASONING_LOCAL
      );
    }
  });

  test(`${lane}: managed replay suppression wins over a trusted context`, () => {
    cacheReasoning(SHARED_ID, "deepseek", "deepseek-v4-flash", REASONING_A, contextA);
    assertExcludesReasoning(
      translateLane(lane, SHARED_ID, {
        reasoningCacheContext: contextA,
        skipReasoningReplay: true,
      }),
      REASONING_A
    );
  });

  test(`${lane}: live raw legacy entries never enter outgoing requests`, () => {
    setReasoningCache(
      SHARED_ID,
      "deepseek",
      "deepseek-v4-flash",
      "Legacy unscoped private reasoning"
    );
    for (const context of [contextA, contextB, localContext, null]) {
      assertExcludesReasoning(
        translateLane(lane, SHARED_ID, { reasoningCacheContext: context }),
        "Legacy unscoped private reasoning"
      );
    }
  });
}

test("cache replay stays principal-scoped after memory eviction and DB promotion", () => {
  cacheReasoning(SHARED_ID, "deepseek", "deepseek-v4-flash", REASONING_A, contextA);
  cacheReasoning(SHARED_ID, "deepseek", "deepseek-v4-flash", REASONING_B, contextB);
  for (let i = 0; i < 205; i++) {
    cacheReasoning(
      `filler_${i}`,
      "deepseek",
      "deepseek-v4-flash",
      "Unrelated cached reasoning",
      contextA
    );
  }
  for (const lane of lanes) {
    const outgoingA = translateLane(lane, SHARED_ID, { reasoningCacheContext: contextA });
    const outgoingB = translateLane(lane, SHARED_ID, { reasoningCacheContext: contextB });
    assertContainsReasoning(outgoingA, REASONING_A);
    assertContainsReasoning(outgoingB, REASONING_B);
    assertExcludesReasoning(outgoingA, REASONING_B);
    assertExcludesReasoning(outgoingB, REASONING_A);
  }
});

test("a precomputed storage key in a tool ID is rehashed, never used as authorization", () => {
  cacheReasoning(SHARED_ID, "deepseek", "deepseek-v4-flash", REASONING_A, contextA);
  const storageId = getReasoningCacheEntries()[0].toolCallId;
  assert.match(storageId, /^rc2h:[a-f0-9]{64}$/);
  for (const lane of lanes) {
    for (const context of [contextA, contextB, localContext, null]) {
      assertExcludesReasoning(
        translateLane(lane, storageId, { reasoningCacheContext: context }),
        REASONING_A
      );
    }
  }
  cacheReasoning(storageId, "deepseek", "deepseek-v4-flash", REASONING_B, contextB);
  const outgoingB = translateLane("chat", storageId, { reasoningCacheContext: contextB });
  assertContainsReasoning(outgoingB, REASONING_B);
  assertExcludesReasoning(outgoingB, REASONING_A);
  assertContainsReasoning(
    translateLane("chat", SHARED_ID, { reasoningCacheContext: contextA }),
    REASONING_A
  );
});

test("adversarial logical IDs cannot select another principal or legacy storage row", () => {
  const ids = [
    "id:with:delimiters\x1fapi-key:A",
    "conversation:forged-transcript-digest",
    "api-key:A:session:forged",
    `rc2h:${"a".repeat(64)}`,
    "call_推論_🔒",
    `call_${"x".repeat(2048)}`,
  ];
  for (const id of ids) {
    setReasoningCache(id, "deepseek", "deepseek-v4-flash", "Legacy private text");
    cacheReasoning(id, "deepseek", "deepseek-v4-flash", REASONING_A, contextA);
    const outgoingA = translateLane("chat", id, { reasoningCacheContext: contextA });
    const outgoingB = translateLane("chat", id, { reasoningCacheContext: contextB });
    assertContainsReasoning(outgoingA, REASONING_A);
    assertExcludesReasoning(outgoingA, "Legacy private text");
    assertExcludesReasoning(outgoingB, REASONING_A, "Legacy private text");
  }
});

test("Claude ID sanitization can miss but cannot cross principal boundaries", () => {
  const rawId = "call:untrusted/id";
  const sanitizedId = "call_untrusted_id";
  cacheReasoning(rawId, "glmt", "glm-replay-test-thinking", "Raw-ID reasoning", contextA);
  // The raw ID changes during Claude preparation, so this is a safe miss.
  assertExcludesReasoning(
    translateLane("claude", rawId, { reasoningCacheContext: contextA }),
    "Raw-ID reasoning"
  );
  cacheReasoning(sanitizedId, "glmt", "glm-replay-test-thinking", REASONING_A, contextA);
  assertContainsReasoning(
    translateLane("claude", rawId, { reasoningCacheContext: contextA }),
    REASONING_A
  );
  assertExcludesReasoning(
    translateLane("claude", rawId, { reasoningCacheContext: contextB }),
    REASONING_A,
    "Raw-ID reasoning"
  );
});

test("body and provider credentials cannot supply a replay context in playground or GLM-style calls", () => {
  cacheReasoning(SHARED_ID, "glmt", "glm-replay-test-thinking", REASONING_A, contextA);
  cacheReasoning(SHARED_ID, "glmt", "glm-replay-test-thinking", REASONING_LOCAL, localContext);
  for (const target of [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE]) {
    const output = translateRequest(
      FORMATS.OPENAI,
      target,
      "glm-replay-test-thinking",
      {
        ...chatBody(),
        thinking: { type: "enabled", budget_tokens: 4096 },
        reasoningCacheContext: contextA,
        _reasoningCacheContext: contextA,
        reasoningCacheScope: "api-key:A:session:forged",
        apiKeyInfo: { id: "A" },
        session_id: "shared-client-controlled-session",
      },
      false,
      { reasoningCacheContext: contextA, apiKey: "fabricated-upstream-key" },
      "glm",
      null,
      { preserveCacheControl: false }
    );
    assertExcludesReasoning(output, REASONING_A, REASONING_LOCAL);
  }
});

test("reasoning-only transcript replay requires both trusted principal and matching scope", () => {
  const scope = "shared-client-session";
  const messages = [
    { role: "user", content: "What is the answer?" },
    { role: "assistant", content: "The answer is 42." },
  ];
  const logicalId = buildAssistantMessageCacheKey(scope, messages, 1);
  cacheReasoningByKey(logicalId, "deepseek", "deepseek-v4-flash", REASONING_A, contextA);
  for (const target of [FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES]) {
    for (const context of [contextA, contextB, localContext, null]) {
      const output = translateRequest(
        FORMATS.OPENAI,
        target,
        "deepseek-v4-flash",
        { messages: structuredClone(messages) },
        false,
        null,
        "deepseek",
        null,
        { reasoningCacheScope: scope, reasoningCacheContext: context }
      );
      if (context === contextA) assertContainsReasoning(output, REASONING_A);
      else assertExcludesReasoning(output, REASONING_A);
    }
    const missingScope = translateRequest(
      FORMATS.OPENAI,
      target,
      "deepseek-v4-flash",
      { messages: structuredClone(messages) },
      false,
      null,
      "deepseek",
      null,
      { reasoningCacheContext: contextA }
    );
    assertExcludesReasoning(missingScope, REASONING_A);
  }
});

test("direct Claude helper preserves placeholders on disabled replay for both lookup branches", () => {
  cacheReasoning(SHARED_ID, "glmt", "glm-replay-test-thinking", REASONING_LOCAL, localContext);
  for (const redacted of [false, true]) {
    const trusted = prepareClaudeRequest(claudeBody(SHARED_ID, redacted), "glmt", false, null, {
      reasoningCacheContext: localContext,
    });
    assertContainsReasoning(trusted, REASONING_LOCAL);
    const missing = prepareClaudeRequest(claudeBody(SHARED_ID, redacted), "glmt");
    assertExcludesReasoning(missing, REASONING_LOCAL);
    assertContainsReasoning(missing, NON_ANTHROPIC_THINKING_PLACEHOLDER);
    const skipped = prepareClaudeRequest(claudeBody(SHARED_ID, redacted), "glmt", false, null, {
      reasoningCacheContext: localContext,
      skipReasoningReplay: true,
    });
    assertExcludesReasoning(skipped, REASONING_LOCAL);
    assertContainsReasoning(skipped, NON_ANTHROPIC_THINKING_PLACEHOLDER);
  }
});

test("MiMo cache-miss placeholder behavior remains unchanged without a trusted context", () => {
  cacheReasoning(SHARED_ID, "xiaomi-mimo", "mimo-v2-pro", REASONING_LOCAL, localContext);
  const output = translateRequest(
    FORMATS.OPENAI,
    FORMATS.OPENAI,
    "mimo-v2-pro",
    chatBody(),
    false,
    null,
    "xiaomi-mimo"
  );
  assertExcludesReasoning(output, REASONING_LOCAL);
  assertContainsReasoning(output, NON_ANTHROPIC_THINKING_PLACEHOLDER);
});
