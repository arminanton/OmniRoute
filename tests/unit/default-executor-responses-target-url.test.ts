import assert from "node:assert/strict";
import test from "node:test";

import { DefaultExecutor } from "../../open-sse/executors/default.ts";

test("DefaultExecutor routes responses-target models on custom-base connections to /responses", () => {
  const executor = new DefaultExecutor("muse-code");
  const credentials = {
    providerSpecificData: { baseUrl: "https://api.meta.ai/v1" },
  } as Parameters<DefaultExecutor["buildUrl"]>[3];

  const url = executor.buildUrl("llama-4-maverick", false, 0, credentials);
  assert.equal(url, "https://api.meta.ai/v1/responses");
});

test("DefaultExecutor keeps the chat URL for unknown custom-base models", () => {
  const executor = new DefaultExecutor("muse-code");
  const credentials = {
    providerSpecificData: { baseUrl: "https://api.meta.ai/v1" },
  } as Parameters<DefaultExecutor["buildUrl"]>[3];

  const url = executor.buildUrl("totally-unknown-model", false, 0, credentials);
  assert.equal(url, "https://api.meta.ai/v1/chat/completions");
});

test("DefaultExecutor keeps the chat URL for chat-target models on custom-base connections", () => {
  const executor = new DefaultExecutor("openai");
  const credentials = {
    providerSpecificData: { baseUrl: "https://proxy.example/v1" },
  } as Parameters<DefaultExecutor["buildUrl"]>[3];

  const url = executor.buildUrl("gpt-4.1", false, 0, credentials);
  assert.equal(url, "https://proxy.example/v1/chat/completions");
});
