/**
 * Unit tests for the UC (uncensored.com) capability additions beyond text+tools:
 *   • the tool-dialect layer (code-style + Gemini <tool_code> parsing, refusal
 *     detection) for guardrailed persona models,
 *   • the persona input-media blob-upload layer (vision + doc), and
 *   • the vision catalog flags.
 * All hermetic — mocked fetch, no live network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  ucUsesCodestyle,
  ucLooksLikeRefusal,
  parseCodestyleCalls,
  parseToolcodeCalls,
  parseUcExtraDialects,
  UC_CODESTYLE_MODELS,
} from "../../open-sse/executors/uc/toolDialect.ts";
import {
  extractCurrentTurnMedia,
  resolveUcRemoteImages,
  uploadUcBlob,
} from "../../open-sse/executors/uc/media.ts";
import { buildPersonaFrame } from "../../open-sse/executors/uc/protocol.ts";
import { validateUcBlobName, validateUcRemoteUrl } from "../../open-sse/executors/uc/urlSafety.ts";
import { UC_MODELS, UC_REGISTRY_MODELS } from "../../open-sse/executors/uc/catalog.ts";

// ─── Tool dialect ────────────────────────────────────────────────────────────

const WEATHER_TOOL = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];

test("ucUsesCodestyle is true only for the guardrailed model set", () => {
  assert.ok(ucUsesCodestyle("gpt-5.5"));
  assert.ok(!ucUsesCodestyle("claude-opus-46"));
  assert.ok(UC_CODESTYLE_MODELS.has("gpt-5.5"));
});

test("parseCodestyleCalls parses positional and keyword python-style calls", () => {
  const pos = parseCodestyleCalls('get_weather("Paris")', WEATHER_TOOL);
  assert.equal(pos.length, 1);
  assert.equal(pos[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(pos[0].function.arguments), { city: "Paris" });

  const kw = parseCodestyleCalls('get_weather(city="Lisbon")', WEATHER_TOOL);
  assert.deepEqual(JSON.parse(kw[0].function.arguments), { city: "Lisbon" });
});

test("parseCodestyleCalls only fires on DECLARED tool names (no prose false-positive)", () => {
  // A sentence that looks like a call but isn't a declared tool → ignored.
  assert.equal(parseCodestyleCalls("I think about this (deeply)", WEATHER_TOOL).length, 0);
  assert.equal(parseCodestyleCalls('unknown_fn("x")', WEATHER_TOOL).length, 0);
});

test("parseToolcodeCalls parses the Gemini <tool_code> print(mod.fn(..)) dialect", () => {
  const calls = parseToolcodeCalls(
    `<tool_code>\nprint(hermes_tools.get_weather(city='Berlin'))\n</tool_code>`,
    WEATHER_TOOL
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "get_weather"); // module prefix stripped
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: "Berlin" });
});

test("parseUcExtraDialects prefers code-style for code-style models, else falls back", () => {
  // gpt-5.5 (code-style): the fn("x") form parses.
  assert.equal(parseUcExtraDialects('get_weather("Rome")', WEATHER_TOOL, "gpt-5.5").length, 1);
  // default model: code-style still works as a universal fallback.
  assert.equal(
    parseUcExtraDialects('get_weather("Rome")', WEATHER_TOOL, "claude-opus-46").length,
    1
  );
  // Gemini dialect works too.
  assert.equal(
    parseUcExtraDialects(
      "<tool_code>print(get_weather(city='X'))</tool_code>",
      WEATHER_TOOL,
      "gemini-emotional"
    ).length,
    1
  );
});

test("ucLooksLikeRefusal flags a short guardrail refusal but not a long real answer", () => {
  assert.ok(ucLooksLikeRefusal("I'm sorry, but I cannot assist with that."));
  assert.ok(!ucLooksLikeRefusal("x".repeat(500) + " i cannot assist with that"));
  assert.ok(!ucLooksLikeRefusal("Here is a helpful answer about the weather in Paris."));
});

// ─── Media input (vision + doc blob-upload) ──────────────────────────────────

const PNG_DATA_URL = "data:image/png;base64," + Buffer.from("fakepngbytes").toString("base64");
const PDF_DATA_URL =
  "data:application/pdf;base64," + Buffer.from("%PDF-1.4 fake").toString("base64");

test("extractCurrentTurnMedia pulls data-url images and remote image urls from the last user turn", () => {
  const { inline, remoteImageUrls, requestedMediaCount } = extractCurrentTurnMedia([
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://ex.com/a.png" } }] },
    { role: "assistant", content: "ok" },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: PNG_DATA_URL } },
      ],
    },
  ]);
  // only the CURRENT (last) user turn's media
  assert.equal(inline.length, 1);
  assert.equal(inline[0].contentType, "image/png");
  assert.equal(remoteImageUrls.length, 0);
  assert.equal(requestedMediaCount, 1);
});

test("resolveUcRemoteImages uses the guarded resolver and preserves bytes + MIME", async () => {
  const resolved = await resolveUcRemoteImages(
    ["https://example.com/a.png"],
    async (urls, opts) => {
      assert.deepEqual(urls, ["https://example.com/a.png"]);
      assert.equal(opts?.prepareForWire, false);
      return [{ data: Buffer.from("png"), mimeType: "image/png", uuid: "u" }];
    }
  );
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].contentType, "image/png");
  assert.equal(resolved[0].bytes.toString(), "png");
});

test("resolveUcRemoteImages rejects loopback through the canonical SSRF guard", async () => {
  await assert.rejects(
    () => resolveUcRemoteImages(["http://127.0.0.1/private.png"]),
    /blocked|url/i
  );
});

test("UC server-returned URL allow-list accepts captured hosts and rejects SSRF pivots", () => {
  assert.equal(
    validateUcRemoteUrl("https://d.moveinwater.com/up/token", "upload").hostname,
    "d.moveinwater.com"
  );
  assert.equal(
    validateUcRemoteUrl("https://gen.moveinwater.com/img_x.png", "image-result").hostname,
    "gen.moveinwater.com"
  );
  assert.equal(
    validateUcRemoteUrl("https://videogen.moveinwater.com/result", "video-result").hostname,
    "videogen.moveinwater.com"
  );
  assert.equal(
    validateUcRemoteUrl(
      "https://api.uncensored.com/api/v1/videos/generations/job_1",
      "direct-status"
    ).hostname,
    "api.uncensored.com"
  );
  assert.throws(
    () => validateUcRemoteUrl("http://169.254.169.254/latest/meta-data", "upload"),
    /https/i
  );
  assert.throws(
    () => validateUcRemoteUrl("https://evil.example/up/token", "upload"),
    /not allowed/i
  );
  assert.throws(
    () => validateUcRemoteUrl("https://d.moveinwater.com/not-upload/token", "upload"),
    /path/i
  );
  assert.equal(validateUcBlobName("uid_ts_1-month_uuid"), "uid_ts_1-month_uuid");
  assert.throws(() => validateUcBlobName("../metadata"), /invalid/i);
});

test("extractCurrentTurnMedia decodes OpenAI file, input_file, and Claude document parts", () => {
  const openaiFile = extractCurrentTurnMedia([
    {
      role: "user",
      content: [{ type: "file", file: { filename: "report.pdf", file_data: PDF_DATA_URL } }],
    },
  ]);
  assert.equal(openaiFile.inline[0].contentType, "application/pdf");

  const claudeDoc = extractCurrentTurnMedia([
    {
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: Buffer.from("x").toString("base64"),
          },
        },
      ],
    },
  ]);
  assert.equal(claudeDoc.inline[0].contentType, "application/pdf");
});

test("extractCurrentTurnMedia counts malformed recognized attachment parts", () => {
  for (const part of [
    { type: "file", file: { filename: "missing.pdf" } },
    { type: "input_file", filename: "missing.pdf" },
    { type: "document", source: { type: "base64", media_type: "application/pdf" } },
  ]) {
    const result = extractCurrentTurnMedia([{ role: "user", content: [part] }]);
    assert.equal(result.requestedMediaCount, 1);
    assert.equal(result.inline.length, 0);
    assert.equal(result.remoteImageUrls.length, 0);
  }
});

test("extractCurrentTurnMedia returns empty for a plain text turn", () => {
  const { inline } = extractCurrentTurnMedia([{ role: "user", content: "hello" }]);
  assert.equal(inline.length, 0);
});

test("uploadUcBlob runs the signed-url → PUT → ready flow and returns the blob descriptor", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}`);
    if (u.includes("/generate-signed-url")) {
      return new Response(
        JSON.stringify({ signed_url: "https://d.moveinwater.com/up/tok", blob_name: "blob_123" }),
        { status: 200 }
      );
    }
    if (u.includes("/up/tok")) {
      assert.equal(init?.redirect, "error");
      return new Response("", { status: 200 }); // PUT
    }
    if (u.includes("/blob_123")) {
      assert.equal(init?.redirect, "error");
      return new Response("", { status: 200 }); // ready HEAD
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  const blob = await uploadUcBlob(
    { bytes: Buffer.from("img"), contentType: "image/png" },
    { jwt: "jwt", uid: "uid-1", fetchImpl: fakeFetch }
  );
  assert.ok(blob);
  assert.equal(blob!.blobName, "blob_123");
  assert.equal(blob!.contentType, "image/png");
  // The signed-url POST carried the Bearer + content_type; the PUT sent the bytes.
  assert.ok(calls.some((c) => c.startsWith("POST") && c.includes("/generate-signed-url")));
  assert.ok(calls.some((c) => c.startsWith("PUT") && c.includes("/up/tok")));
});

test("uploadUcBlob reports signed-url failure so the executor can fail closed", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const blob = await uploadUcBlob(
    { bytes: Buffer.from("x"), contentType: "image/png" },
    { jwt: "j", uid: "u", fetchImpl: fakeFetch }
  );
  assert.equal(blob, null);
});

test("uploadUcBlob disables redirects for a server-supplied upload URL", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("/generate-signed-url")) {
      return new Response(
        JSON.stringify({
          signed_url: "https://d.moveinwater.com/up/redirect",
          blob_name: "blob_1",
        }),
        { status: 200 }
      );
    }
    if (value === "https://d.moveinwater.com/up/redirect") {
      if (init.redirect !== "error") {
        calls.push("https://second-host.example/stolen");
        return new Response(null, { status: 200 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://second-host.example/stolen" },
      });
    }
    if (value === "https://second-host.example/stolen") {
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch to ${value}`);
  }) as unknown as typeof fetch;

  const blob = await uploadUcBlob(
    { bytes: Buffer.from("x"), contentType: "image/png" },
    { jwt: "j", uid: "u", fetchImpl: fakeFetch }
  );
  assert.equal(blob, null);
  assert.equal(calls.includes("https://second-host.example/stolen"), false);
});

test("uploadUcBlob readiness polling rejects redirects without fetching the second host", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("/generate-signed-url")) {
      return new Response(
        JSON.stringify({
          signed_url: "https://d.moveinwater.com/up/ready",
          blob_name: "blob_ready",
        }),
        { status: 200 }
      );
    }
    if (value === "https://d.moveinwater.com/up/ready") {
      return new Response(null, { status: 200 });
    }
    if (value === "https://d.moveinwater.com/blob_ready") {
      if (init.redirect !== "error") {
        calls.push("https://second-host.example/blob_ready");
        return new Response(null, { status: 200 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: "https://second-host.example/blob_ready" },
      });
    }
    throw new Error(`unexpected fetch to ${value}`);
  }) as unknown as typeof fetch;

  const blob = await uploadUcBlob(
    { bytes: Buffer.from("x"), contentType: "image/png" },
    {
      jwt: "j",
      uid: "u",
      fetchImpl: fakeFetch,
      readyTimeoutMs: 100,
      sleepImpl: async () => undefined,
    }
  );
  assert.equal(blob, null);
  assert.equal(calls.includes("https://d.moveinwater.com/blob_ready"), true);
  assert.equal(calls.includes("https://second-host.example/blob_ready"), false);
});

test("uploadUcBlob returns null when the uploaded blob never becomes ready", async () => {
  const fakeFetch = (async (url: string) => {
    const value = String(url);
    if (value.includes("/generate-signed-url")) {
      return new Response(
        JSON.stringify({ signed_url: "https://d.moveinwater.com/up/tok", blob_name: "blob_wait" }),
        { status: 200 }
      );
    }
    if (value.includes("/up/tok")) return new Response("", { status: 200 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  const blob = await uploadUcBlob(
    { bytes: Buffer.from("x"), contentType: "image/png" },
    {
      jwt: "j",
      uid: "u",
      fetchImpl: fakeFetch,
      readyTimeoutMs: 1,
      sleepImpl: async () => undefined,
    }
  );
  assert.equal(blob, null);
});

test("buildPersonaFrame carries a media blob when provided (and stays clean without one)", () => {
  const withMedia = buildPersonaFrame({
    model: "claude-opus-46",
    text: "hi",
    history: [],
    uid: "uid",
    media: [{ blobName: "blob_9", contentType: "image/png" }],
  });
  assert.equal(withMedia.media_blob_name, "blob_9");
  assert.equal(withMedia.media_content_type, "image/png");
  const multiple = buildPersonaFrame({
    model: "claude-opus-46",
    text: "hi",
    history: [],
    uid: "uid",
    media: [
      { blobName: "one", contentType: "image/png" },
      { blobName: "two", contentType: "application/pdf" },
    ],
  });
  assert.equal("media_blob_names" in multiple, false);
  assert.equal("_uc_media_count" in multiple, false);

  const noMedia = buildPersonaFrame({
    model: "claude-opus-46",
    text: "hi",
    history: [],
    uid: "uid",
  });
  assert.equal(noMedia.media_blob_name, "");
  assert.equal(noMedia.media_content_type, "");
});

// ─── Vision catalog flags ────────────────────────────────────────────────────

test("catalog flags the vision-capable persona models (and not the text-only ones)", () => {
  const visionCount = UC_MODELS.filter((m) => m.supportsVision).length;
  assert.equal(visionCount, 15);
  const byId = new Map(UC_MODELS.map((m) => [m.id, m]));
  assert.ok(byId.get("claude-opus-46")?.supportsVision);
  assert.ok(byId.get("grok-4-3")?.supportsVision);
  assert.ok(byId.get("kimi-k2.5")?.supportsVision);
  // text-only models must NOT be flagged
  assert.ok(!byId.get("deepseek-r1")?.supportsVision);
  assert.ok(!byId.get("glm-5.1")?.supportsVision);
  assert.ok(!byId.get("minimax-m2-her")?.supportsVision);
});

test("UC_REGISTRY_MODELS surfaces supportsVision so /v1/models advertises it", () => {
  const claude = UC_REGISTRY_MODELS.find((m) => m.id === "claude-opus-46");
  assert.ok(claude?.supportsVision);
  const deepseek = UC_REGISTRY_MODELS.find((m) => m.id === "deepseek-r1");
  assert.ok(!deepseek?.supportsVision);
});
