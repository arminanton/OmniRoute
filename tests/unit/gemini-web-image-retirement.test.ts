import { mockGeminiBrowserLease } from "./helpers/geminiBrowserLease.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const { getAllImageModels, getImageProvider, parseImageModel } =
  await import("../../open-sse/config/imageRegistry.ts");
const { handleImageGeneration } = await import("../../open-sse/handlers/imageGeneration.ts");
const geminiWebExecutorModule = await import("../../open-sse/executors/gemini-web.ts");
const { GeminiWebExecutor } = geminiWebExecutorModule;
const { getExecutor, hasSpecializedExecutor } = await import("../../open-sse/executors/index.ts");
const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");

test("Gemini Web image generation is absent from the public image catalog and request path", async () => {
  assert.equal(getImageProvider("gemini-web"), null);
  assert.equal(getImageProvider("gweb"), null);
  assert.equal(
    getAllImageModels().some(
      ({ provider, id }) => provider === "gemini-web" || id === "gemini-web/nano-banana-web"
    ),
    false
  );

  const result = await handleImageGeneration({
    body: {
      model: "gemini-web/nano-banana-web",
      prompt: "a red panda eating bamboo",
    },
    credentials: { apiKey: "unused-cookie" },
    log: null,
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /Invalid image model/);
});

test("Gemini Web executor treats the retired image-mode extension as ordinary chat input", async () => {
  const playwright = await import("playwright");
  const originalLaunch = playwright.chromium.launch;
  const waitDurations: number[] = [];

  const candidate: unknown[] = [];
  candidate[1] = ["standard chat reply"];
  const extensions: unknown[] = [];
  extensions[7] = [[[[null, null, null, "https://lh3.googleusercontent.com/retired-image"]]]];
  candidate[12] = extensions;
  const payload = JSON.stringify([null, [], null, null, [candidate]]);
  const frame = JSON.stringify([["wrb.fr", null, payload]]);
  const raw = `)]}'\n${frame.length}\n${frame}\n`;

  playwright.chromium.launch = (async () =>
    ({
      newContext: async () => ({
        addCookies: async () => {},
        newPage: async () => {
          let requestHandler: (request: any) => void;
          let responseHandler: (response: any) => Promise<void>;
          const streamUrl = "https://gemini.google.com/_/StreamGenerate";
          return {
            on: (event: string, handler: any) => {
              if (event === "request") requestHandler = handler;
              if (event === "response") responseHandler = handler;
            },
            goto: async () => {},
            waitForTimeout: async (duration: number) => {
              waitDurations.push(duration);
            },
            waitForSelector: async () => ({ click: async () => {} }),
            keyboard: {
              type: async () => {},
              press: async () => {
                await Promise.resolve();
                const request = { url: () => streamUrl };
                requestHandler(request);
                await responseHandler({
                  url: () => streamUrl,
                  text: async () => raw,
                  status: () => 200,
                  request: () => request,
                });
              },
            },
          };
        },
      }),
      close: async () => {},
    }) as unknown as Awaited<ReturnType<typeof originalLaunch>>) as typeof originalLaunch;

  try {
    const result = await new GeminiWebExecutor(mockGeminiBrowserLease).execute({
      model: "gemini-3.1-pro",
      body: {
        messages: [{ role: "user", content: "hello" }],
        x_gemini_web_image_mode: true,
      },
      stream: false,
      credentials: { apiKey: "fake-cookie=abc" },
      signal: AbortSignal.timeout(5000),
      log: null,
    });

    assert.equal(result.response.status, 200);
    const json = (await result.response.json()) as Record<string, unknown>;
    assert.equal(json.x_gemini_web_image_urls, undefined);
    assert.equal(
      (json.choices as Array<{ message: { content: string } }>)[0].message.content,
      "standard chat reply"
    );
    assert.equal(waitDurations.includes(90_000), false);
    assert.equal(waitDurations.includes(30_000), true);
  } finally {
    playwright.chromium.launch = originalLaunch;
  }
});

test("Gemini Web image-only parser and handler artifacts are retired", () => {
  assert.equal("parseStreamResponseImages" in geminiWebExecutorModule, false);
  assert.equal(
    existsSync(
      new URL("../../open-sse/handlers/imageGeneration/providers/geminiWeb.ts", import.meta.url)
    ),
    false
  );
});

test("Gemini Web chat and legitimate Gemini image providers remain available", async () => {
  assert.equal(hasSpecializedExecutor("gemini-web"), true);
  assert.equal((await getExecutor("gemini-web")).getProvider(), "gemini-web");
  assert.equal(REGISTRY["gemini-web"]?.executor, "gemini-web");
  assert.deepEqual(
    REGISTRY["gemini-web"]?.models.map(({ id }) => id),
    ["gemini-3.1-pro", "gemini-3.7-flash", "gemini-3.1-flash-lite"]
  );

  assert.deepEqual(parseImageModel("nano-banana"), {
    provider: "adobe-firefly",
    model: "nano-banana",
  });
  assert.deepEqual(parseImageModel("openrouter/google/gemini-3-pro-image-preview"), {
    provider: "openrouter",
    model: "google/gemini-3-pro-image-preview",
  });
});
