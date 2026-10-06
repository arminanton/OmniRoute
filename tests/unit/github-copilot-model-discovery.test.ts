/**
 * Issues #3120 / #3121 — GitHub Copilot model discovery (thanks @gabrielmoreira).
 *
 * #3120: "Import Models" never refreshes the Copilot model list because the
 *        `github` (Copilot) provider had a STATIC hardcoded catalog and no live
 *        discovery source.
 * #3121: That static catalog advertised models (e.g. gemini previews) that the
 *        account is not entitled to, so testing them returned upstream 400s.
 *
 * Fix: discover the catalog live from https://api.githubcopilot.com/models using
 * the Copilot bearer + Copilot chat headers, parse `data[].id` into managed
 * models, and fall back to the static catalog only when the live fetch fails.
 *
 * Discovery cases use injected fetch; the final routing contract uses an isolated DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousDataDir = process.env.DATA_DIR;
const previousApiKeySecret = process.env.API_KEY_SECRET;
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-copilot-routing-"));
let resetDbInstance = () => {};
test.before(() => {
  process.env.DATA_DIR = testDataDir;
  process.env.API_KEY_SECRET ||= "copilot-routing-test-secret";
});
test.after(() => {
  resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousApiKeySecret === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = previousApiKeySecret;
});

const {
  GITHUB_COPILOT_MODELS_URL,
  GITHUB_COPILOT_MODEL_ALLOWLIST,
  GITHUB_COPILOT_STATIC_FALLBACK_MODELS,
  parseGitHubCopilotModels,
  fetchGitHubCopilotModels,
} = await import("../../open-sse/services/githubCopilotModels.ts");

// A representative slice of a real Copilot /models response. The upstream list
// includes selectable chat models plus utility/legacy models; discovery now
// keeps every entitled CHAT model (capability-driven) and drops only non-chat
// rows (embeddings / completion).
const MOCK_COPILOT_MODELS_RESPONSE = {
  data: [
    {
      id: "gpt-5.4",
      name: "GPT-5.4",
      model_picker_enabled: true,
      policy: { state: "enabled" },
      capabilities: { type: "chat", limits: { max_context_window_tokens: 128000 } },
    },
    {
      id: "disabled-by-policy",
      name: "Disabled by policy",
      model_picker_enabled: true,
      policy: { state: "disabled" },
      capabilities: { type: "chat" },
    },
    {
      id: "hidden-from-picker",
      name: "Hidden from picker",
      model_picker_enabled: false,
      policy: { state: "enabled" },
      capabilities: { type: "chat" },
    },
    {
      id: "claude-sonnet-4.5",
      name: "Claude Sonnet 4.5",
      model_picker_enabled: true,
      capabilities: { type: "chat" },
    },
    {
      // Newly-entitled model NOT in any hardcoded list — must still be kept now
      // that discovery is capability-driven (this is the whole point of the fix).
      id: "grok-4.6",
      name: "Grok 4.6",
      model_picker_enabled: true,
      capabilities: { type: "chat" },
      supported_endpoints: ["/responses"],
    },
    {
      // Embeddings model — present upstream but not a routable chat model.
      id: "text-embedding-3-small",
      name: "Embedding V3 small",
      capabilities: { type: "embeddings" },
    },
    {
      // Raw completion utility — also excluded.
      id: "gpt-41-copilot",
      name: "Copilot Completion",
      capabilities: { type: "completion" },
    },
  ],
};

test("#3120 parseGitHubCopilotModels keeps every entitled CHAT model (capability-driven)", () => {
  const models = parseGitHubCopilotModels(MOCK_COPILOT_MODELS_RESPONSE);
  const ids = models.map((m) => m.id);
  // grok-4.6 is kept even though it is in no hardcoded allowlist — it's an
  // entitled chat model in the live response.
  assert.deepEqual(ids, ["gpt-5.4", "claude-sonnet-4.5", "grok-4.6"]);
  const gpt = models.find((m) => m.id === "gpt-5.4");
  assert.ok(gpt, "gpt-5.4 entry present");
  assert.equal(gpt.name, "GPT-5.4");
  assert.equal(gpt.owned_by, "github");
  assert.ok(!ids.includes("text-embedding-3-small"), "embeddings models are skipped");
  assert.ok(!ids.includes("gpt-41-copilot"), "completion utility models are skipped");
  assert.ok(!ids.includes("disabled-by-policy"), "policy.state=disabled is not routable");
  assert.ok(!ids.includes("hidden-from-picker"), "model_picker_enabled=false is not routable");
});

test("discovery normalizes supported endpoints and selects Responses only when chat is absent", () => {
  const models = parseGitHubCopilotModels({
    data: [
      {
        id: "new-responses-model",
        capabilities: {
          type: "chat",
          supported_endpoints: [
            " /v1/responses/ ",
            "/v1/responses/",
            null,
            42,
            "",
            "/v1//responses",
          ],
        },
      },
      {
        id: "chat-and-responses",
        capabilities: { type: "chat", supported_endpoints: ["/responses"] },
        supported_endpoints: ["/v1/chat/completions", "/responses"],
      },
      {
        id: "malformed-endpoints",
        capabilities: { type: "chat" },
        supported_endpoints: [null, 42, "", "not a path", "https://example.com/responses"],
      },
      {
        id: "claude-responses-model",
        capabilities: { type: "chat" },
        supported_endpoints: ["/responses"],
      },
    ],
  });
  const byId = new Map(models.map((model) => [model.id, model]));

  assert.deepEqual(byId.get("new-responses-model"), {
    id: "new-responses-model",
    name: "new-responses-model",
    owned_by: "github",
    supportedEndpoints: ["responses"],
    targetFormat: "openai-responses",
  });
  assert.deepEqual(byId.get("chat-and-responses")?.supportedEndpoints, ["chat", "responses"]);
  assert.equal(byId.get("chat-and-responses")?.targetFormat, undefined);
  assert.deepEqual(byId.get("malformed-endpoints"), {
    id: "malformed-endpoints",
    name: "malformed-endpoints",
    owned_by: "github",
  });
  assert.deepEqual(byId.get("claude-responses-model")?.supportedEndpoints, ["responses"]);
  assert.equal(byId.get("claude-responses-model")?.targetFormat, undefined);
});

test("Copilot endpoint metadata survives synced-model import normalization", async () => {
  const { normalizeDiscoveredModels } =
    await import("../../src/lib/providerModels/modelDiscovery.ts");
  const discovered = parseGitHubCopilotModels({
    data: [
      { id: "responses-only", supported_endpoints: ["/v1/responses"] },
      {
        id: "chat-and-responses",
        supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
      },
    ],
  });
  const imported = new Map(
    normalizeDiscoveredModels(discovered, "github").map((model) => [model.id, model])
  );

  assert.deepEqual(imported.get("responses-only")?.supportedEndpoints, ["responses"]);
  assert.equal(imported.get("responses-only")?.targetFormat, "openai-responses");
  assert.deepEqual(imported.get("chat-and-responses")?.supportedEndpoints, ["chat", "responses"]);
  assert.equal(imported.get("chat-and-responses")?.targetFormat, undefined);
});

test("#3121 a model NOT in the live response is not advertised (entitlement filtering)", () => {
  const models = parseGitHubCopilotModels(MOCK_COPILOT_MODELS_RESPONSE);
  const ids = models.map((m) => m.id);
  // gemini-3.1-pro-preview is not entitled here (absent from the live response).
  assert.ok(
    !ids.includes("gemini-3.1-pro-preview"),
    "non-entitled gemini preview must NOT be advertised"
  );
});

test("#3120 fetchGitHubCopilotModels does a live fetch and returns parsed models", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const fakeFetch = (async (url: string, init: RequestInit) => {
    capturedUrl = String(url);
    capturedHeaders = (init?.headers as Record<string, string>) || {};
    return new Response(JSON.stringify(MOCK_COPILOT_MODELS_RESPONSE), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const result = await fetchGitHubCopilotModels({
    token: "copilot-tok-abc",
    fetchImpl: fakeFetch,
  });

  assert.equal(capturedUrl, GITHUB_COPILOT_MODELS_URL);
  assert.equal(
    capturedHeaders.Authorization,
    "Bearer copilot-tok-abc",
    "must authenticate with the Copilot bearer token"
  );
  // Copilot chat headers must be present (e.g. copilot-integration-id).
  assert.ok(capturedHeaders["copilot-integration-id"], "must send Copilot integration header");
  assert.equal(result.source, "api");
  const ids = result.models.map((m) => m.id);
  assert.deepEqual(ids, ["gpt-5.4", "claude-sonnet-4.5", "grok-4.6"]);
  assert.ok(!ids.includes("gemini-3.1-pro-preview"));
});

test("#3120/#3121 fetch falls back to static catalog when the live fetch fails", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const fallback = [
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "gpt-3.5-turbo", name: "GPT 3.5 Turbo" },
  ];

  const result = await fetchGitHubCopilotModels({
    token: "copilot-tok-abc",
    fetchImpl: fakeFetch,
    fallbackModels: fallback,
  });

  assert.equal(result.source, "fallback");
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["gpt-5.4", "gemini-3.1-pro-preview"],
    "offline/failed discovery must preserve only the curated static catalog"
  );
});

test("static fallback catalog is the alias of the allowlist and covers the approved chat ids", () => {
  // Back-compat: the old name still points at the fallback catalog.
  assert.equal(GITHUB_COPILOT_MODEL_ALLOWLIST, GITHUB_COPILOT_STATIC_FALLBACK_MODELS);
  const set = new Set<string>(GITHUB_COPILOT_STATIC_FALLBACK_MODELS);
  // The fallback must include the newly-entitled families so an offline import
  // (which can only draw from this static list) still surfaces them.
  for (const id of [
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4.8-fast",
    "claude-opus-4.6",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gpt-5.4-nano",
    "grok-4.6",
    "grok-4.5",
    "mai-code-1.1-flash",
    "mai-code-1-flash-picker",
  ]) {
    assert.ok(set.has(id), `static fallback must include ${id}`);
  }
  // No embeddings / completion utilities belong in the chat fallback catalog.
  assert.ok(!set.has("text-embedding-3-small"));
  assert.ok(!set.has("gpt-41-copilot"));
});

test("newly approved Copilot models survive live and fallback discovery", async () => {
  const expected = ["claude-opus-5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
  const live = parseGitHubCopilotModels({ data: expected.map((id) => ({ id, name: id })) });
  assert.deepEqual(
    live.map((model) => model.id),
    expected
  );

  const fallback = await fetchGitHubCopilotModels({
    token: "",
    fallbackModels: expected.map((id) => ({ id, name: id })),
  });
  assert.deepEqual(
    fallback.models.map((model) => model.id),
    expected
  );
});

test("fetch falls back when no token is provided (unauthed refresh stays safe)", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await fetchGitHubCopilotModels({
    token: "",
    fetchImpl: fakeFetch,
    fallbackModels: [{ id: "gpt-5.4", name: "GPT-5.4" }],
  });

  assert.equal(called, false, "must not fetch without a token");
  assert.equal(result.source, "fallback");
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["gpt-5.4"]
  );
});

test("Copilot endpoint metadata persists through dispatch", async () => {
  const core = await import("../../src/lib/db/core.ts");
  resetDbInstance = core.resetDbInstance;
  const providers = await import("../../src/lib/db/providers.ts");
  const { getCachedDiscoveredModels, persistDiscoveredModels } =
    await import("../../src/lib/providerModels/modelDiscovery.ts");
  const { getModelInfo } = await import("../../src/sse/services/model.ts");
  const { resolveChatCoreTargetFormat } =
    await import("../../open-sse/handlers/chatCore/targetFormat.ts");
  const { resolveExecutionCredentials } =
    await import("../../open-sse/handlers/chatCore/executionCredentials.ts");
  const { GithubExecutor } = await import("../../open-sse/executors/github.ts");
  const connection = await providers.createProviderConnection({
    provider: "github",
    authType: "oauth",
    name: "discovered-routing-test",
    isActive: true,
    testStatus: "active",
  });
  const discovered = parseGitHubCopilotModels({
    data: [
      { id: "responses-only", supported_endpoints: ["/v1/responses"] },
      {
        id: "chat-and-responses",
        supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
      },
    ],
  });
  await persistDiscoveredModels("github", connection.id, discovered);
  const cached = await getCachedDiscoveredModels("github", connection.id);
  assert.deepEqual(cached.find((model) => model.id === "responses-only")?.supportedEndpoints, [
    "responses",
  ]);
  assert.deepEqual(cached.find((model) => model.id === "chat-and-responses")?.supportedEndpoints, [
    "chat",
    "responses",
  ]);

  const executor = new GithubExecutor();
  const route = async (id: string) => {
    const info = await getModelInfo(`gh/${id}`);
    const { targetFormat } = resolveChatCoreTargetFormat({
      provider: info.provider,
      resolvedModel: info.model,
      apiFormat: info.apiFormat,
      sourceFormat: "openai",
      customModelTargetFormat: info.targetFormat,
      providerSpecificData: {},
    });
    const credentials = resolveExecutionCredentials({
      credentials: { providerSpecificData: {} },
      provider: info.provider,
      targetFormat,
      nativeCodexPassthrough: false,
      endpointPath: "/v1/chat/completions",
      ccSessionId: null,
    });
    return {
      targetFormat,
      url: executor.buildUrl(info.model, false, 0, credentials),
    };
  };

  assert.deepEqual(await route("responses-only"), {
    targetFormat: "openai-responses",
    url: "https://api.githubcopilot.com/responses",
  });
  assert.deepEqual(await route("chat-and-responses"), {
    targetFormat: "openai",
    url: "https://api.githubcopilot.com/chat/completions",
  });
});
