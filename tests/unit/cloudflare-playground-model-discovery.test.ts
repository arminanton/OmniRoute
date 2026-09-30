import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseCloudflarePlaygroundCatalog,
  discoverCloudflarePlaygroundModels,
  fetchCloudflareCatalogEnvelope,
  requestCloudflareCatalog,
} from "../../src/lib/providerModels/cloudflarePlaygroundModels.ts";
const captured = JSON.parse(
  readFileSync(new URL("../fixtures/cloudflare-playground-catalog.json", import.meta.url), "utf8")
);
test("captured CFP catalog uses slugs and excludes LoRA and safety models", () => {
  const models = parseCloudflarePlaygroundCatalog(captured);
  assert.equal(models?.length, 21);
  assert.equal(models?.[0].id, "openai/gpt-oss-120b");
  assert.ok(models?.every((m) => !/lora|llama-guard/.test(m.id)));
  assert.ok(models?.every((m) => Object.keys(m).sort().join() === "id,name"));
});
test("CFP only completed successful array RPCs are authoritative", () => {
  for (const payload of [
    null,
    {},
    { ...captured, success: false },
    { ...captured, done: false },
    { ...captured, type: "cf_agent_state" },
    { ...captured, result: {} },
  ])
    assert.equal(parseCloudflarePlaygroundCatalog(payload), null);
  assert.deepEqual(parseCloudflarePlaygroundCatalog({ ...captured, result: [] }), []);
  assert.deepEqual(
    parseCloudflarePlaygroundCatalog({
      ...captured,
      result: [
        { name: "@cf/image/model", task: { name: "Text-to-Image" } },
        { id: "uuid", task: { name: "Text Generation" } },
      ],
    }),
    []
  );
});
test("CFP discovery unavailable fails to null, successful empty remains empty", async () => {
  assert.equal(
    await discoverCloudflarePlaygroundModels(async () => {
      throw new Error("offline");
    }),
    null
  );
  assert.deepEqual(
    await discoverCloudflarePlaygroundModels(async () => ({ ...captured, result: [] })),
    []
  );
});

test("CFP transport navigates inert origin and releases page/context on success and error", async () => {
  for (const fail of [false, true]) {
    let released = 0;
    let contextReleased = 0;
    let evaluations = 0;
    const page = {
      route: async () => {},
      goto: async (url: string) => {
        assert.equal(url, "https://playground.ai.cloudflare.com/");
        if (fail) throw new Error("navigation failed");
      },
      evaluate: async (fn: unknown) => {
        evaluations++;
        return fn === requestCloudflareCatalog ? captured : undefined;
      },
    };
    const deps = {
      acquire: async () => ({
        page,
        release: async () => {
          released++;
        },
      }),
      release: async () => {
        contextReleased++;
      },
    } as unknown as NonNullable<Parameters<typeof fetchCloudflareCatalogEnvelope>[1]>;
    if (fail) await assert.rejects(fetchCloudflareCatalogEnvelope(100, deps));
    else assert.deepEqual(await fetchCloudflareCatalogEnvelope(100, deps), captured);
    assert.equal(released, 1);
    assert.equal(contextReleased, 1);
    assert.equal(evaluations, fail ? 0 : 2);
  }
});
test("CFP deadline bounds pending acquisition and cleans up a late lease", async () => {
  let finish: ((lease: unknown) => void) | undefined;
  let pageReleased = 0;
  let contextReleased = 0;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const deps = {
    acquire: () => pending,
    release: async () => {
      contextReleased++;
    },
  } as unknown as NonNullable<Parameters<typeof fetchCloudflareCatalogEnvelope>[1]>;
  await assert.rejects(fetchCloudflareCatalogEnvelope(5, deps), /deadline/);
  finish!({
    release: async () => {
      pageReleased++;
    },
  });
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pageReleased, 1);
  assert.ok(contextReleased >= 1);
});
test("CFP page protocol sends only one getModels RPC and closes matching result", async () => {
  const original = globalThis.WebSocket;
  const sent: string[] = [];
  let closed = 0;
  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror = null;
    onclose = null;
    constructor(url: string) {
      assert.match(url, /^wss:\/\/playground\.ai\.cloudflare\.com\/agents\/playground\//);
      queueMicrotask(() => this.onopen?.());
    }
    send(raw: string) {
      sent.push(raw);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(captured) }));
    }
    close() {
      closed++;
    }
  }
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    assert.deepEqual(
      await requestCloudflareCatalog({ timeoutMs: 100, maxBytes: 2_000_000 }),
      captured
    );
    assert.deepEqual(
      sent.map((raw) => JSON.parse(raw)),
      [{ type: "rpc", id: "catalog-models", method: "getModels", args: [] }]
    );
    assert.equal(closed, 1);
  } finally {
    globalThis.WebSocket = original;
  }
});

test("Workers API paid-plan metadata does not exclude Playground models", () => {
  const models = parseCloudflarePlaygroundCatalog(captured);
  for (const id of ["zai-org/glm-5.3", "zai-org/glm-5.3-flash"]) {
    const upstream = captured.result.find((row: { name: string }) => row.name === `@cf/${id}`);
    assert.ok(
      upstream.properties.some(
        (property: { property_id: string; value: string }) =>
          property.property_id === "require_workers_paid" && property.value === "true"
      )
    );
    assert.ok(models?.some((model) => model.id === id));
  }
});
