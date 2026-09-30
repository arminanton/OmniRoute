import test from "node:test";
import assert from "node:assert/strict";
import {
  __setBrowserBackedChatOverrideForTesting,
  __resetBrowserBackedChatOverrideForTesting,
  __setHttpBackedChatOverrideForTesting,
  __resetHttpBackedChatOverrideForTesting,
} from "../../open-sse/services/browserBackedChat.ts";
import { DuckDuckGoWebExecutor } from "../../open-sse/executors/duckduckgo-web.ts";
import type { Page, Route } from "playwright";

test("DDG browser transport preserves requested model and history without generic HTTP", async () => {
  const previous = process.env.OMNIROUTE_BROWSER_POOL;
  process.env.OMNIROUTE_BROWSER_POOL = "on";
  let httpCalls = 0;
  let patched: Record<string, unknown> | null = null;
  __setHttpBackedChatOverrideForTesting(async () => {
    httpCalls++;
    throw new Error("generic HTTP must not run");
  });
  __setBrowserBackedChatOverrideForTesting(async (request) => {
    assert.equal(typeof request.beforeSubmit, "function");
    const page = {
      route: async (url: string, handler: (route: Route) => Promise<void>) => {
        assert.equal(url, "https://duck.ai/duckchat/v1/chat");
        await handler({
          request: () => ({
            method: () => "POST",
            postDataJSON: () => ({
              model: "ui-default",
              messages: [],
              reasoningEffort: "none",
              durableStream: { messageId: "browser-id" },
              metadata: { toolChoice: {} },
              canUseTools: true,
            }),
          }),
          continue: async (options: { postData: string }) => {
            patched = JSON.parse(options.postData);
          },
        } as unknown as Route);
      },
    } as unknown as Page;
    await request.beforeSubmit!(page);
    return {
      status: 200,
      contentType: "text/event-stream",
      body: Buffer.from('data: {"message":"ok"}\n\n'),
      isStealth: true,
      timing: { acquireContextMs: 0, navigateMs: 0, submitMs: 0, captureResponseMs: 0, totalMs: 0 },
    };
  });
  try {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "prior" },
      { role: "user", content: "last" },
    ];
    const result = await new DuckDuckGoWebExecutor().execute({
      model: "claude-haiku-4-5",
      body: { messages },
      stream: false,
      credentials: {},
      signal: new AbortController().signal,
    });
    assert.equal((result instanceof Response ? result : result.response).status, 200);
    assert.equal(httpCalls, 0);
    assert.deepEqual(patched, {
      model: "claude-haiku-4-5",
      messages,
      reasoningEffort: "low",
      durableStream: { messageId: "browser-id" },
      metadata: { toolChoice: {} },
      canUseTools: true,
    });
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_BROWSER_POOL;
    else process.env.OMNIROUTE_BROWSER_POOL = previous;
    __resetBrowserBackedChatOverrideForTesting();
    __resetHttpBackedChatOverrideForTesting();
  }
});

for (const invalid of [null, [], {}, { model: "ui-default", messages: "bad" }]) {
  test(`DDG browser aborts unsupported payload ${JSON.stringify(invalid)}`, async () => {
    const previous = process.env.OMNIROUTE_BROWSER_POOL;
    process.env.OMNIROUTE_BROWSER_POOL = "on";
    let aborted = false;
    __setBrowserBackedChatOverrideForTesting(async (request) => {
      await request.beforeSubmit!({
        route: async (_url: string, handler: (route: Route) => Promise<void>) => {
          await handler({
            request: () => ({ method: () => "POST", postDataJSON: () => invalid }),
            continue: async () => {
              throw new Error("must not send invalid payload");
            },
            abort: async () => {
              aborted = true;
            },
          } as unknown as Route);
        },
      } as unknown as Page);
      return {
        status: 200,
        contentType: "text/event-stream",
        body: Buffer.from(""),
        isStealth: true,
        timing: {
          acquireContextMs: 0,
          navigateMs: 0,
          submitMs: 0,
          captureResponseMs: 0,
          totalMs: 0,
        },
      };
    });
    try {
      const result = await new DuckDuckGoWebExecutor().execute({
        model: "gpt-5.4-mini",
        body: { messages: [{ role: "user", content: "hello" }] },
        stream: false,
        credentials: {},
        signal: new AbortController().signal,
      });
      assert.equal((result instanceof Response ? result : result.response).status, 502);
      assert.equal(aborted, true);
    } finally {
      if (previous === undefined) delete process.env.OMNIROUTE_BROWSER_POOL;
      else process.env.OMNIROUTE_BROWSER_POOL = previous;
      __resetBrowserBackedChatOverrideForTesting();
    }
  });
}

test("DDG browser refuses unpatched success rather than claiming another model ran", async () => {
  const previous = process.env.OMNIROUTE_BROWSER_POOL;
  process.env.OMNIROUTE_BROWSER_POOL = "on";
  __setBrowserBackedChatOverrideForTesting(async () => ({
    status: 200,
    contentType: "text/event-stream",
    body: Buffer.from(""),
    isStealth: true,
    timing: { acquireContextMs: 0, navigateMs: 0, submitMs: 0, captureResponseMs: 0, totalMs: 0 },
  }));
  try {
    const result = await new DuckDuckGoWebExecutor().execute({
      model: "gpt-5.4-mini",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: {},
      signal: new AbortController().signal,
    });
    const response = result instanceof Response ? result : result.response;
    assert.equal(response.status, 502);
    assert.match(await response.text(), /could not preserve/);
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_BROWSER_POOL;
    else process.env.OMNIROUTE_BROWSER_POOL = previous;
    __resetBrowserBackedChatOverrideForTesting();
  }
});
