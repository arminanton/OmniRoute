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

const { getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
const { supportsXHighEffort } = await import("../../open-sse/config/providerModels.ts");
const { sanitizeReasoningEffortForProvider } = await import("../../open-sse/executors/base.ts");
const { getExecutor, hasSpecializedExecutor } = await import("../../open-sse/executors/index.ts");
const { MoonshotExecutor, normalizeMoonshotRequest } =
  await import("../../open-sse/executors/moonshot.ts");
const { sanitizeOpenAIResponse, sanitizeResponsesApiResponse, sanitizeStreamingChunk } =
  await import("../../open-sse/handlers/responseSanitizer.ts");
const {
  cacheReasoning,
  cacheReasoningByKey,
  buildAssistantMessageCacheKey,
  deleteReasoningCacheEntry,
  requiresReasoningReplay,
} = await import("../../open-sse/services/reasoningCache.ts");
const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { getResolvedModelCapabilities } = await import("../../src/lib/modelCapabilities.ts");
const { createLocalReasoningCacheContext } =
  await import("../../open-sse/services/reasoningCacheContext.ts");
const reasoningCacheContext = createLocalReasoningCacheContext();
const { resetDbInstance } = await import("../../src/lib/db/core.ts");

test.after(() => {
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousApiKeySecret === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = previousApiKeySecret;
});

const EXPECTED_MODELS = ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"];

function registryModelIds(provider: string): string[] {
  const entry = getRegistryEntry(provider);
  assert.ok(entry, `${provider} registry entry must exist`);
  return (entry.models ?? []).map((model) => model.id);
}

function buildVideoRequest() {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this clip" },
          { type: "video_url", video_url: { url: "https://example.com/clip.mp4" } },
        ],
      },
    ],
  };
}

test("Moonshot and hidden legacy Kimi ids share the curated model catalog", () => {
  assert.deepEqual(registryModelIds("moonshot"), EXPECTED_MODELS);
  assert.deepEqual(registryModelIds("kimi"), EXPECTED_MODELS);
});

test("Kimi K3 advertises its 1M context/output and native capabilities", () => {
  const capabilities = getResolvedModelCapabilities({ provider: "moonshot", model: "kimi-k3" });

  assert.equal(capabilities.contextWindow, 1048576);
  assert.equal(capabilities.maxOutputTokens, 1048576);
  assert.equal(capabilities.supportsThinking, true);
  assert.equal(capabilities.supportsTools, true);
  assert.equal(capabilities.supportsVision, true);
  assert.equal(capabilities.interleavedField, "reasoning_content");
});

test("Moonshot ids use the specialized request normalizer", async () => {
  assert.equal(hasSpecializedExecutor("moonshot"), true);
  assert.equal(hasSpecializedExecutor("kimi"), true);
  assert.ok((await getExecutor("moonshot")) instanceof MoonshotExecutor);
  assert.ok((await getExecutor("kimi")) instanceof MoonshotExecutor);
});

test("Kimi K3 uses max reasoning, fixed sampling, and max_completion_tokens", () => {
  const input = {
    max_tokens: 2000000,
    temperature: 0.3,
    top_p: 0.5,
    frequency_penalty: 1,
    presence_penalty: 1,
    n: 2,
    thinking: { type: "disabled" },
    enable_thinking: false,
    reasoning: { effort: "low", summary: "auto" },
    reasoning_effort: "low",
    tool_choice: "required",
    messages: [{ role: "assistant", content: "done", reasoning_content: "work" }],
  };
  const output = normalizeMoonshotRequest("kimi-k3", input) as Record<string, unknown>;

  assert.equal(output.max_completion_tokens, 1048576);
  assert.equal(output.max_tokens, undefined);
  assert.equal(output.temperature, undefined);
  assert.equal(output.top_p, undefined);
  assert.equal(output.frequency_penalty, undefined);
  assert.equal(output.presence_penalty, undefined);
  assert.equal(output.n, undefined);
  assert.equal(output.thinking, undefined);
  assert.equal(output.enable_thinking, undefined);
  assert.equal(output.reasoning, undefined);
  assert.equal(output.reasoning_effort, "max");
  assert.equal(output.tool_choice, "required");
  assert.deepEqual(output.messages, input.messages);
  assert.equal(input.max_tokens, 2000000, "normalization must not mutate the caller's object");
});

test("Kimi K2.7 forces preserved thinking and downgrades unsupported required tools", () => {
  const output = normalizeMoonshotRequest("kimi-k2.7-code-highspeed", {
    max_completion_tokens: 999999,
    thinking: { type: "disabled" },
    enable_thinking: false,
    reasoning_effort: "none",
    tool_choice: "required",
  }) as Record<string, unknown>;

  assert.equal(output.max_completion_tokens, 262144);
  assert.deepEqual(output.thinking, { type: "enabled", keep: "all" });
  assert.equal(output.enable_thinking, undefined);
  assert.equal(output.reasoning_effort, undefined);
  assert.equal(output.tool_choice, "auto");
});

test("Kimi K2.6 maps effort to thinking and downgrades required tool choice", () => {
  const disabled = normalizeMoonshotRequest("kimi-k2.6", {
    reasoning: { effort: "none" },
    tool_choice: "required",
  }) as Record<string, unknown>;
  const enabled = normalizeMoonshotRequest("kimi-k2.6", {
    reasoning_effort: "high",
  }) as Record<string, unknown>;

  assert.deepEqual(disabled.thinking, { type: "disabled" });
  assert.equal(disabled.tool_choice, "auto");
  assert.deepEqual(enabled.thinking, { type: "enabled" });
});

test("Moonshot K2.6 keeps legacy reasoning replay while K3 never fabricates it", () => {
  const executor = new MoonshotExecutor();
  const body = {
    thinking: { type: "enabled" },
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      },
    ],
  };
  const credentials = { apiKey: "test" };
  const k26 = executor.transformRequest("kimi-k2.6", body, false, credentials) as {
    messages: Array<Record<string, unknown>>;
  };
  const k3 = executor.transformRequest("kimi-k3", body, false, credentials) as {
    messages: Array<Record<string, unknown>>;
  };

  assert.equal(typeof k26.messages[0].reasoning_content, "string");
  assert.equal(Object.hasOwn(k3.messages[0], "reasoning_content"), false);
});

test("Moonshot K3 keeps literal max effort through base sanitation", () => {
  assert.equal(supportsXHighEffort("moonshot", "kimi-k3"), false);
  for (const provider of ["moonshot", "kimi"]) {
    const output = sanitizeReasoningEffortForProvider(
      { reasoning_effort: "max" },
      provider,
      "kimi-k3"
    ) as Record<string, unknown>;
    assert.equal(output.reasoning_effort, "max");
  }
});

test("Moonshot K3 participates in reasoning replay", () => {
  assert.equal(
    requiresReasoningReplay({
      provider: "moonshot",
      model: "kimi-k3",
      allowLegacyFallback: true,
    }),
    true
  );
});

test("Responses history preserves authentic reasoning for native Moonshot K3", () => {
  for (const provider of ["moonshot", "kimi"]) {
    const output = translateRequest(
      "openai-responses",
      "openai",
      "kimi-k3",
      {
        model: "kimi-k3",
        reasoning: { effort: "max" },
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Call search." }],
          },
          {
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "I should search first." }],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "search",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "found",
          },
        ],
      },
      false,
      null,
      provider
    ) as { messages: Array<Record<string, unknown>> };

    assert.equal(output.messages[1].reasoning_content, "I should search first.");
    assert.deepEqual(output.messages[1].tool_calls, [
      {
        id: "call_1",
        type: "function",
        function: { name: "search", arguments: "{}" },
      },
    ]);
  }
});

test("video_url is preserved only for Moonshot's OpenAI-compatible extension", () => {
  const moonshot = translateRequest(
    "openai",
    "openai",
    "kimi-k3",
    buildVideoRequest(),
    false,
    null,
    "moonshot"
  ) as { messages: Array<{ content: Array<{ type: string }> }> };
  const generic = translateRequest(
    "openai",
    "openai",
    "llama-model",
    buildVideoRequest(),
    false,
    null,
    "groq"
  ) as { messages: Array<{ content: Array<{ type: string }> }> };

  assert.deepEqual(
    moonshot.messages[0].content.map((part) => part.type),
    ["text", "video_url"]
  );
  assert.deepEqual(
    generic.messages[0].content.map((part) => part.type),
    ["text"]
  );
});

test("Moonshot keeps empty partial assistant prefixes without replaying reasoning", () => {
  const scope = "api-key:test\x1fpartial-prefix";
  const messages = [
    {
      role: "assistant",
      content: "",
      name: "Kal'tsit",
      partial: true,
    },
  ];
  const cacheKey = buildAssistantMessageCacheKey(scope, messages, 0);
  cacheReasoningByKey(
    cacheKey,
    "moonshot",
    "kimi-k3",
    "unrelated prior reasoning",
    reasoningCacheContext
  );

  try {
    const output = translateRequest(
      "openai",
      "openai",
      "kimi-k3",
      { messages },
      false,
      null,
      "moonshot",
      null,
      { reasoningCacheScope: scope, reasoningCacheContext }
    ) as { messages: Array<Record<string, unknown>> };

    assert.equal(output.messages.length, 1);
    assert.equal(output.messages[0].content, "");
    assert.equal(output.messages[0].name, "Kal'tsit");
    assert.equal(output.messages[0].partial, true);
    assert.equal(Object.hasOwn(output.messages[0], "reasoning_content"), false);
  } finally {
    deleteReasoningCacheEntry(cacheKey, reasoningCacheContext);
  }
});

test("Moonshot K3 and K2.7 replay only authentic reasoning content", () => {
  for (const model of ["kimi-k3", "kimi-k2.7-code"]) {
    const missingCacheId = `call_missing_${model.replace(/[^a-z0-9]/gi, "_")}`;
    const withoutCache = translateRequest(
      "openai",
      "openai",
      model,
      {
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: missingCacheId,
                type: "function",
                function: { name: "search", arguments: "{}" },
              },
            ],
          },
        ],
      },
      false,
      null,
      "moonshot"
    ) as { messages: Array<Record<string, unknown>> };
    assert.equal(Object.hasOwn(withoutCache.messages[0], "reasoning_content"), false);

    const cachedId = `call_cached_${model.replace(/[^a-z0-9]/gi, "_")}`;
    cacheReasoning(
      cachedId,
      "moonshot",
      model,
      `real reasoning for ${model}`,
      reasoningCacheContext
    );
    try {
      const withCache = translateRequest(
        "openai",
        "openai",
        model,
        {
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: cachedId,
                  type: "function",
                  function: { name: "search", arguments: "{}" },
                },
              ],
            },
          ],
        },
        false,
        null,
        "moonshot",
        null,
        { reasoningCacheContext }
      ) as { messages: Array<Record<string, unknown>> };
      assert.equal(withCache.messages[0].reasoning_content, `real reasoning for ${model}`);
    } finally {
      deleteReasoningCacheEntry(cachedId, reasoningCacheContext);
    }
  }
});

test("Moonshot flat cached_tokens survives non-streaming and streaming sanitization", () => {
  const usage = {
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
    cached_tokens: 7,
    provider_only_debug: true,
  };
  const nonStreaming = sanitizeOpenAIResponse({
    id: "chatcmpl_moonshot",
    object: "chat.completion",
    created: 1,
    model: "kimi-k3",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
    usage,
  }) as { usage: Record<string, unknown> };
  const streaming = sanitizeStreamingChunk({
    id: "chatcmpl_moonshot",
    object: "chat.completion.chunk",
    created: 1,
    model: "kimi-k3",
    choices: [],
    usage,
  }) as { usage: Record<string, unknown> };
  const responses = sanitizeResponsesApiResponse({
    id: "chatcmpl_moonshot",
    object: "chat.completion",
    created: 1,
    model: "kimi-k3",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
    usage,
  }) as { usage: { input_tokens_details: Record<string, unknown> } };

  assert.equal(nonStreaming.usage.cached_tokens, 7);
  assert.equal(streaming.usage.cached_tokens, 7);
  assert.equal(responses.usage.input_tokens_details.cached_tokens, 7);
  assert.equal(Object.hasOwn(nonStreaming.usage, "provider_only_debug"), false);
  assert.equal(Object.hasOwn(streaming.usage, "provider_only_debug"), false);
});
