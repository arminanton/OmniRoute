import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GeminiWebExecutor } from "../../open-sse/executors/gemini-web.ts";

function fixture(options: { status?: number; raw?: string; missingInput?: boolean; persistThrows?: boolean } = {}) {
  let requestListener: (request: unknown) => void;
  let responseListener: (response: unknown) => Promise<void>;
  let released = 0;
  const updates: any[] = [];
  const page = {
    on: (event: string, cb: any) => {
      if (event === "request") requestListener = cb;
      if (event === "response") responseListener = cb;
    },
    goto: async () => {},
    waitForTimeout: async () => {},
    waitForSelector: async () => options.missingInput ? null : { click: async () => {} },
    keyboard: {
      type: async () => {},
      press: async () => {
        await Promise.resolve();
        const request = { url: () => "https://gemini.google.com/StreamGenerate" };
        requestListener(request);
        await responseListener({ url: request.url, status: () => options.status ?? 200, text: async () => options.raw ?? '["answer"]', request: () => request });
      },
    },
  };
  const context = { cookies: async () => [
    { name: "__Secure-1PSID", value: "old", domain: ".google.com" },
    { name: "__Secure-1PSIDTS", value: "new", domain: ".google.com" },
  ] };
  const executor = new GeminiWebExecutor((async () => {
    return { page, context, release: async () => { released++; } };
  }) as any);
  const run = () => executor.execute({
    model: "gemini-2.5-flash-lite", body: { messages: [{ role: "user", content: "hi" }] }, stream: false,
    credentials: { apiKey: "__Secure-1PSID=old; __Secure-1PSIDTS=before" },
    onCredentialsRefreshed: async (update: any) => { updates.push(update); if (options.persistThrows) throw new Error("storage unavailable"); },
  } as any);
  return { run, updates, state: () => ({ released }) };
}

function textFrame(text: string) {
  const payload = Array(5).fill(null);
  payload[4] = [["candidate", [text]]];
  return JSON.stringify([["wrb.fr", "rpc", JSON.stringify(payload)]]);
}

describe("Gemini Web reliability", () => {
  for (const status of [401, 403, 429, 503]) {
    it(`retains HTTP ${status} rather than treating error body as content`, async () => {
      const f = fixture({ status, raw: textFrame("not a success") });
      assert.equal((await f.run()).response.status, status);
      assert.equal(f.state().released, 1);
      assert.equal(f.updates.length, 1);
    });
  }
  it("rejects structured quota error on HTTP 200", async () => {
    const f = fixture({ raw: JSON.stringify([["wrb.fr", null, null, null, null, [null, null, [[null, [1037]]]]]]) });
    assert.equal((await f.run()).response.status, 429);
  });
  it("rejects malformed response even when valid text precedes it", async () => {
    const f = fixture({ raw: textFrame("partial") + "\n[invalid" });
    assert.equal((await f.run()).response.status, 502);
  });
  it("persists rotated cookies on missing input and releases after persistence failure", async () => {
    const f = fixture({ missingInput: true, persistThrows: true });
    assert.equal((await f.run()).response.status, 401);
    assert.equal(f.updates.length, 1);
    assert.equal(f.state().released, 1);
  });
});
