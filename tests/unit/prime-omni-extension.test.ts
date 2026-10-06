import assert from "node:assert/strict";
import test from "node:test";
import { createOmniExtension } from "../../integrations/prime-agent/omni/index.ts";

const model = (id = "cx/gpt-6.1-sol-medium") => ({
  id,
  owned_by: "codex",
  context_length: 872000,
  max_output_tokens: 128000,
  capabilities: { reasoning: true, effort_tiers: ["low", "medium", "high"] },
  supported_endpoints: ["responses"],
  pricing: { input: 2, output: 10, cached: 0.1 },
});
type Api = Parameters<ReturnType<typeof createOmniExtension>>[0];
type PrimeModel = {
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  cost: Record<string, number>;
};
function harness() {
  const registrations: { id: string; config: { models: PrimeModel[] } }[] = [];
  const commands = new Map<string, Parameters<Api["registerCommand"]>[1]>();
  const events = new Map<string, Parameters<Api["on"]>[1]>();
  const notices: [string, string][] = [];
  const pi: Api = {
    registerProvider: (id, config) => {
      registrations.push({ id, config: config as { models: PrimeModel[] } });
    },
    registerCommand: (name, command) => {
      commands.set(name, command);
    },
    on: (name, callback) => {
      events.set(name, callback);
    },
  };
  const ctx = {
    ui: {
      notify: (message: string, level: string) => {
        notices.push([message, level]);
      },
    },
  };
  return { pi, ctx, registrations, commands, events, notices };
}
const catalog = (data: unknown[]) => Response.json({ object: "list", data });

for (const [host, baseUrl] of Object.entries({
  maria: "http://127.0.0.1:20129/v1",
  devvm: "https://omni.saga-gourami.ts.net/v1",
})) {
  test(`${host}: alias/configured discovery preserves verified limits and effective rates`, async () => {
    const h = harness();
    const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(url, `${baseUrl}/models?prefix=alias&configuredOnly=true`);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-secret");
      return catalog([model(), { ...model("agy/image"), type: "image" }]);
    };
    await createOmniExtension({
      baseUrl,
      readKey: () => "fixture-secret",
      fetch: fetcher as typeof fetch,
    })(h.pi);
    const models = h.registrations[0].config.models;
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "cx/gpt-6.1-sol-medium");
    assert.equal(models[0].contextWindow, 872000);
    assert.equal(models[0].maxTokens, 128000);
    assert.deepEqual(models[0].cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
    assert.equal(models[0].api, "openai-responses");
  });
}

test("body timeout is distinguished from malformed JSON and failed discovery retains registry", async () => {
  const h = harness();
  let failed = false;
  const fetcher = async () =>
    failed
      ? new Response(
          new ReadableStream({
            start(c) {
              c.error(new DOMException("fixture timeout", "TimeoutError"));
            },
          })
        )
      : catalog([model()]);
  await createOmniExtension({ readKey: () => "fixture", fetch: fetcher as typeof fetch })(h.pi);
  failed = true;
  await h.commands.get("omni-refresh").handler("", h.ctx);
  assert.equal(h.registrations.length, 1);
  assert.match(h.notices[0][0], /timed out while reading/);
  assert.doesNotMatch(h.notices[0][0], /invalid JSON/);
});

test("reload replacement removes departed entitlements without emitting canonical duplicates", async () => {
  const h = harness();
  let data = [model(), model("cx/gpt-6-astra-medium")];
  await createOmniExtension({
    readKey: () => "fixture",
    fetch: (async () => catalog(data)) as typeof fetch,
  })(h.pi);
  data = [model()];
  await h.commands.get("omni-refresh").handler("", h.ctx);
  assert.deepEqual(
    h.registrations.at(-1).config.models.map((m: PrimeModel) => m.id),
    ["cx/gpt-6.1-sol-medium"]
  );
});

test("unknown and dynamic prices are visibly distinct from a known zero rate", async () => {
  const h = harness();
  const zero = { ...model("cx/free"), pricing: { input: 0, output: 0 } };
  const unknown = { ...model("unc/unknown"), pricing: undefined };
  const combo = { ...model("auto/coding"), owned_by: "combo", pricing: undefined };
  await createOmniExtension({
    readKey: () => "fixture",
    fetch: (async () => catalog([zero, unknown, combo])) as typeof fetch,
  })(h.pi);
  const models = h.registrations[0].config.models;
  assert.equal(models[0].name, "cx/free");
  assert.match(models[1].name, /cost unknown/);
  assert.match(models[2].name, /dynamic cost/);
});

test("failed startup surfaces on every resumed session and duplicate catalogs cannot replace registry", async () => {
  const h = harness();
  await createOmniExtension({
    readKey: () => "fixture",
    fetch: (async () => catalog([model(), model()])) as typeof fetch,
  })(h.pi);
  for (const sessionId of ["existing-canonical", "existing-alias", "new-session"]) {
    await h.events.get("session_start")({ sessionId }, h.ctx);
  }
  assert.equal(h.registrations.length, 0);
  assert.equal(h.notices.length, 3);
  assert.ok(
    h.notices.every(([message, level]) => /duplicate model IDs/.test(message) && level === "error")
  );
});

test("concurrent refresh requests share one discovery and cannot race registry replacement", async () => {
  const h = harness();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = async () => {
    calls++;
    if (calls > 1) await gate;
    return catalog([model()]);
  };
  await createOmniExtension({ readKey: () => "fixture", fetch: fetcher as typeof fetch })(h.pi);
  const refresh = h.commands.get("omni-refresh").handler;
  const pending = [refresh("", h.ctx), refresh("", h.ctx), refresh("", h.ctx)];
  release();
  await Promise.all(pending);
  assert.equal(calls, 2);
  assert.equal(h.registrations.length, 2);
});

test("explicit warming responses get one retry, never unlimited retry storms", async () => {
  const h = harness();
  let calls = 0;
  await createOmniExtension({
    readKey: () => "fixture",
    fetch: (async () => {
      calls++;
      return calls === 1
        ? new Response("warming", { status: 503, headers: { "Retry-After": "0" } })
        : catalog([model()]);
    }) as typeof fetch,
  })(h.pi);
  assert.equal(calls, 2);
  assert.equal(h.registrations.length, 1);
});

test("declared native billing units are distinguished from USD estimates and allowance regimes", async () => {
  const h = harness();
  const data = [
    {
      ...model("cx/credits"),
      billing_metadata: {
        credit_rates: { unit: "credits_per_million_tokens" },
        dollar_pricing_basis: "token_value_estimate_not_subscription_invoice",
      },
    },
    { ...model("gh/premium"), billing_metadata: { unit: "premium_requests", multiplier: 0 } },
    { ...model("agy/allowance"), billing_metadata: { regime: "included_allowance" } },
    {
      ...model("free/declared"),
      billing_metadata: { regime: "free" },
      pricing: { input: 0, output: 0 },
    },
  ];
  await createOmniExtension({
    readKey: () => "fixture",
    fetch: (async () => catalog(data)) as typeof fetch,
  })(h.pi);
  const models = h.registrations[0].config.models;
  assert.match(models[0].name, /credits; USD estimate/);
  assert.match(models[1].name, /premium requests/);
  assert.doesNotMatch(models[1].name, /free/);
  assert.match(models[2].name, /included allowance/);
  assert.match(models[3].name, /declared free/);
  await h.commands.get("omni-billing").handler("cx/credits", h.ctx);
  assert.match(h.notices.at(-1)[0], /native_credits/);
});

test("account-advertised ultra effort is preserved without inventing it for other models", async () => {
  const h = harness();
  await createOmniExtension({
    readKey: () => "fixture",
    fetch: (async () =>
      catalog([
        { ...model(), capabilities: { reasoning: true, effort_tiers: ["medium", "max", "ultra"] } },
        model("cx/gpt-6-luna"),
      ])) as typeof fetch,
  })(h.pi);
  const models = h.registrations[0].config.models as Array<
    PrimeModel & { thinkingLevelMap?: Record<string, string> }
  >;
  assert.equal(models[0].thinkingLevelMap?.ultra, "ultra");
  assert.equal(models[1].thinkingLevelMap?.ultra, undefined);
});
