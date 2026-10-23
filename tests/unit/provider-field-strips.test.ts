import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findOffendingField,
  isUnsupportedThinkingError,
  REASONING_REQUEST_FIELDS,
  stripGroqUnsupportedFields,
} from "../../open-sse/config/providerFieldStrips.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";

function mockFetchResponses(...responses: Array<{ status: number; body: string }>) {
  const bodies: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, init: { body?: unknown } = {}) => {
    bodies.push(JSON.parse(String(init.body ?? "{}")));
    const response = responses[Math.min(calls++, responses.length - 1)]!;
    return new Response(response.body, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { bodies, callCount: () => calls, restore: () => void (globalThis.fetch = original) };
}

function reasoningBody(): Record<string, unknown> {
  return {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
    reasoning_effort: "high",
    reasoning: { effort: "high" },
    thinking: { type: "enabled", budget_tokens: 1024 },
    think: true,
  };
}

function executeRelay(body: Record<string, unknown>) {
  return new DefaultExecutor("anthropic-compatible-cc-myrelay").execute({
    model: "claude-opus-4-8",
    body,
    stream: false,
    credentials: {
      apiKey: "relay-key",
      providerSpecificData: { baseUrl: "https://relay.example/v1" },
    },
  });
}

test("isUnsupportedThinkingError requires an explicit reasoning rejection", () => {
  assert.equal(isUnsupportedThinkingError('"Qwen3-Coder:latest" does not support thinking'), true);
  assert.equal(isUnsupportedThinkingError("model does not support reasoning"), true);
  assert.equal(isUnsupportedThinkingError("model does not support reasoning_effort"), false);
  assert.equal(isUnsupportedThinkingError("model rejected max_tokens"), false);
  assert.equal(isUnsupportedThinkingError(""), false);
  assert.deepEqual(
    REASONING_REQUEST_FIELDS,
    ["reasoning_effort", "reasoning", "thinking", "think"]
  );
});

test("findOffendingField matches known field names in a 400 body", () => {
  assert.equal(
    findOffendingField("Invalid argument: reasoning_budget not supported"),
    "reasoning_budget"
  );
  assert.equal(findOffendingField("unexpected field chat_template"), "chat_template");
  assert.equal(findOffendingField("reasoning_content is not allowed"), "reasoning_content");
  // #1468: Claude Code's top-level context_management field rejected by strict
  // anthropic-compatible gateways → strip + retry regardless of the contextEditing flag.
  assert.equal(
    findOffendingField("context_management: Extra inputs are not permitted"),
    "context_management"
  );
  assert.equal(
    findOffendingField("Extra inputs are not permitted, field: 'verbosity', value: 'low'"),
    "verbosity"
  );
  assert.equal(findOffendingField("all good"), null);
  assert.equal(findOffendingField(""), null);
});

test("stripGroqUnsupportedFields drops non-empty messages[].name", () => {
  const out = stripGroqUnsupportedFields({
    messages: [{ role: "user", content: "hi", name: "bob" }],
  });
  assert.equal("name" in out.messages[0], false);
  assert.equal(out.messages[0].content, "hi");
});

test("stripGroqUnsupportedFields drops logprobs/logit_bias/top_logprobs", () => {
  const out = stripGroqUnsupportedFields({
    messages: [],
    logprobs: true,
    logit_bias: { 1: 2 },
    top_logprobs: 5,
  });
  assert.equal("logprobs" in out, false);
  assert.equal("logit_bias" in out, false);
  assert.equal("top_logprobs" in out, false);
});

test("stripGroqUnsupportedFields is immutable (does not mutate input)", () => {
  const input = { messages: [{ role: "user", content: "hi", name: "bob" }], logprobs: true };
  stripGroqUnsupportedFields(input);
  assert.equal(input.messages[0].name, "bob");
  assert.equal(input.logprobs, true);
});

test("stripGroqUnsupportedFields drops unsupported messages[].model and other metadata while keeping role and content", () => {
  const out = stripGroqUnsupportedFields({
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "hello!",
        model: "groq/openai/gpt-oss-20b",
        messageId: "msg_123",
        sender: "assistant",
      },
    ],
  });
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, "user");
  assert.equal(out.messages[0].content, "hello");
  assert.equal(out.messages[1].role, "assistant");
  assert.equal(out.messages[1].content, "hello!");
  assert.equal("model" in out.messages[1], false);
  assert.equal("messageId" in out.messages[1], false);
  assert.equal("sender" in out.messages[1], false);
});

test("an explicit reasoning rejection retries once without reasoning fields", async () => {
  const rejection = JSON.stringify({
    error: { message: '"Qwen3-Coder:latest" does not support thinking' },
  });
  const mock = mockFetchResponses(
    { status: 400, body: rejection },
    { status: 400, body: rejection }
  );
  try {
    await executeRelay(reasoningBody());
  } finally {
    mock.restore();
  }
  assert.equal(mock.callCount(), 2);
  assert.ok(mock.bodies[0]?.thinking);
  for (const field of REASONING_REQUEST_FIELDS) {
    assert.equal(mock.bodies[1]?.[field], undefined, `retry must remove ${field}`);
  }
});

test("accepted reasoning is preserved; ordinary 4xx/5xx do not trigger retry", async () => {
  const accepted = mockFetchResponses({ status: 200, body: JSON.stringify({ ok: true }) });
  try {
    await executeRelay(reasoningBody());
  } finally {
    accepted.restore();
  }
  assert.equal(accepted.callCount(), 1);
  assert.ok(accepted.bodies[0]?.thinking);

  const rejection = JSON.stringify({
    error: { message: '"Qwen3-Coder:latest" does not support thinking' },
  });
  const ordinaryError = JSON.stringify({ error: { message: "max_tokens: must be >= 1" } });
  for (const response of [
    { status: 400, body: ordinaryError },
    { status: 422, body: rejection },
    { status: 500, body: rejection },
  ]) {
    const mock = mockFetchResponses(response, { status: 200, body: JSON.stringify({ ok: true }) });
    try {
      await executeRelay(reasoningBody());
    } finally {
      mock.restore();
    }
    assert.equal(mock.callCount(), 1, `status ${response.status} must not retry`);
    assert.ok(mock.bodies[0]?.thinking, `status ${response.status} must preserve reasoning`);
  }

  const nestedReasoning = mockFetchResponses({ status: 400, body: rejection });
  try {
    await executeRelay({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      generationConfig: { thinkingConfig: { thinkingBudget: 8192 } },
    });
  } finally {
    nestedReasoning.restore();
  }
  assert.equal(nestedReasoning.callCount(), 1, "nested reasoning must not trigger an empty retry");
});

test("network errors do not trigger reasoning fallback", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError("network unavailable");
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(executeRelay(reasoningBody()));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 1);
});

// Routing envelopes must become valid Groq Chat Completions fields.
test("Groq GPT-OSS routing low/none uses low without foreign envelopes", () => {
  for (const effort of ["low", "none"]) {
    const input = {
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: effort,
      reasoning: { effort },
      output_config: { effort },
    };
    const out = stripGroqUnsupportedFields(input, input.model, effort);
    assert.equal(out.reasoning_effort, "low");
    assert.equal("reasoning" in out, false);
    assert.equal("output_config" in out, false);
    assert.deepEqual(out.messages, input.messages);
    assert.equal(input.reasoning_effort, effort);
    assert.deepEqual(input.output_config, { effort });
  }
});

test("Groq forced none uses low without changing defaults or other models", () => {
  const input = { model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "hello" }] };
  const forced = stripGroqUnsupportedFields(input, input.model, "none");
  assert.equal(forced.reasoning_effort, "low");
  assert.equal(
    stripGroqUnsupportedFields(input, input.model, "low").reasoning_effort,
    "low"
  );
  assert.equal(
    "reasoning_effort" in stripGroqUnsupportedFields(input, input.model),
    false,
    "an ordinary effort-less request must retain its provider default"
  );
  assert.equal(
    stripGroqUnsupportedFields({ reasoning_effort: "none" }, input.model).reasoning_effort,
    "none",
    "default mode must not be remapped"
  );
  assert.equal(
    stripGroqUnsupportedFields({ reasoning_effort: "high" }, input.model).reasoning_effort,
    "high"
  );

  const otherModel = stripGroqUnsupportedFields(
    { model: "openai/another-model", reasoning: { effort: "none" }, output_config: { effort: "low" } },
    "openai/another-model",
    "none"
  );
  assert.equal("reasoning_effort" in otherModel, false);
  assert.deepEqual(otherModel.reasoning, { effort: "none" });
  assert.deepEqual(otherModel.output_config, { effort: "low" });
});

