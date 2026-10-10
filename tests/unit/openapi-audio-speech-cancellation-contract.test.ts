import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";
import { handleAudioSpeech } from "../../open-sse/handlers/audioSpeech.ts";

const root = process.cwd();
const canonicalText = fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(root, "public/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as any;
const speechRouteSource = fs.readFileSync(
  path.join(root, "src/app/api/v1/audio/speech/route.ts"),
  "utf8"
);
const speechHandlerSource = fs.readFileSync(
  path.join(root, "open-sse/handlers/audioSpeech.ts"),
  "utf8"
);

test("audio speech documents its source-backed HTTP 499 cancellation response", () => {
  const operation = spec.paths["/api/v1/audio/speech"]?.post;
  assert.ok(operation, "missing POST /api/v1/audio/speech");
  assert.match(speechRouteSource, /signal:\s*request\.signal/);
  assert.match(speechRouteSource, /signal:\s*sharedAdmission\?\.signal\s*\?\?\s*request\.signal/);
  assert.match(speechHandlerSource, /if\s*\(signal\?\.aborted\)\s*return\s+errorResponse\(499,/);

  const cancelled = operation.responses?.["499"];
  assert.ok(cancelled, "speech cancellation must be documented with HTTP 499");
  assert.match(cancelled.description, /abort signal cancelled speech generation/i);
  assert.equal(
    cancelled.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  assert.equal(publicText, canonicalText);
});

test("an aborted speech provider fetch returns the documented 499 JSON error", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  controller.abort(new DOMException("Client disconnected", "AbortError"));
  let fetchSawAbort = false;
  globalThis.fetch = async (_input, init = {}) => {
    fetchSawAbort = (init.signal as AbortSignal | undefined)?.aborted === true;
    throw new DOMException("The operation was aborted", "AbortError");
  };

  try {
    const response = await handleAudioSpeech({
      body: { model: "openai/tts-1", input: "test speech" },
      credentials: { apiKey: "test-key" },
      resolvedProvider: {
        id: "openai",
        format: "openai-compatible",
        authType: "apikey",
        authHeader: "bearer",
        baseUrl: "https://speech.invalid/v1/audio/speech",
      },
      resolvedModel: "tts-1",
      signal: controller.signal,
    });

    assert.equal(fetchSawAbort, true, "the abort signal reaches the provider fetch");
    assert.equal(response.status, 499);
    const body = (await response.json()) as { error?: { message?: string } };
    assert.equal(body.error?.message, "Speech request cancelled");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
