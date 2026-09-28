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
  uploadUcBlob,
  uploadUcTurnMedia,
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

test("extractCurrentTurnMedia returns empty for a plain text turn", () => {
  const { inline } = extractCurrentTurnMedia([{ role: "user", content: "hello" }]);
  assert.equal(inline.length, 0);
});

test("uploadUcBlob runs the signed-url → PUT → ready flow and returns the blob descriptor", async () => {
  // Do not reserialize this opaque query: normalizing a signed token can break it.
  const signedUrl = "https://d.moveinwater.com/up/tok?token=Opaque%2F%2B%3D+%26&expiry=123";
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}`);
    if (u.includes("/generate-signed-url")) {
      return new Response(JSON.stringify({ signed_url: signedUrl, blob_name: "blob_123" }), {
        status: 200,
      });
    }
    if (u.includes("/up/tok")) return new Response("", { status: 200 }); // PUT
    if (u.includes("/blob_123")) return new Response("", { status: 200 }); // ready HEAD
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
  assert.ok(calls.includes(`PUT ${signedUrl}`));
});

test("uploadUcBlob returns null (best-effort) on a signed-url failure", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const blob = await uploadUcBlob(
    { bytes: Buffer.from("x"), contentType: "image/png" },
    { jwt: "j", uid: "u", fetchImpl: fakeFetch }
  );
  assert.equal(blob, null);
});

test("uploadUcTurnMedia uploads several files and skips failures", async () => {
  let n = 0;
  const fakeFetch = (async (url: string) => {
    const u = String(url);
    if (u.includes("/generate-signed-url")) {
      n++;
      // first file succeeds, second fails at signed-url
      if (n === 1) {
        return new Response(
          JSON.stringify({ signed_url: "https://d.moveinwater.com/up/t1", blob_name: "b1" }),
          {
            status: 200,
          }
        );
      }
      return new Response("", { status: 500 });
    }
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  const blobs = await uploadUcTurnMedia(
    [
      { bytes: Buffer.from("a"), contentType: "image/png" },
      { bytes: Buffer.from("b"), contentType: "application/pdf" },
    ],
    { jwt: "j", uid: "u", fetchImpl: fakeFetch }
  );
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].blobName, "b1");
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

test("UC returned URL validation ties HTTPS host and path to each fetch purpose", () => {
  const allowed = [
    ["https://d.moveinwater.com/up/tok?signature=abc", "upload"],
    ["https://gen.moveinwater.com/img_1.png", "image-result"],
    ["https://videogen.moveinwater.com/result_1", "video-result"],
    ["https://api.uncensored.com/api/v1/videos/status/job_1", "direct-status"],
  ] as const;
  for (const [url, purpose] of allowed) assert.equal(validateUcRemoteUrl(url, purpose).href, url);

  const denied = [
    ["http://d.moveinwater.com/up/tok", "upload"],
    ["https://169.254.169.254/up/tok", "upload"],
    ["https://d.moveinwater.com.evil.test/up/tok", "upload"],
    ["https://d.moveinwater.com@127.0.0.1/up/tok", "upload"],
    ["https://@d.moveinwater.com/up/tok", "upload"],
    ["https://d.moveinwater.com:443/up/tok", "upload"],
    ["https://d.moveinwater.com:8443/up/tok", "upload"],
    ["https://d.moveinwater.com/elsewhere", "upload"],
    ["https://d.moveinwater.com/up/../elsewhere", "upload"],
    ["https://d.moveinwater.com/up/junk/../tok", "upload"],
    ["https://d.moveinwater.com/up/%2e%2e/up/tok", "upload"],
    ["https://api.uncensored.com/api/v1/videos/jobs/../status/1", "direct-status"],
    ["https://d.moveinwater.com/up/tok#fragment", "upload"],
    ["https://d.moveinwater.com\\@evil.test/up/tok", "upload"],
    ["https://d.moveinwater.com/up/%2fprivate", "upload"],
    ["https://videogen.moveinwater.com/video", "image-result"],
    ["https://gen.moveinwater.com/img_1.png", "video-result"],
    ["https://api.uncensored.com/api/v1/users/me", "direct-status"],
  ] as const;
  for (const [url, purpose] of denied) {
    assert.throws(() => validateUcRemoteUrl(url, purpose), undefined, `${purpose}: ${url}`);
  }
  assert.equal(validateUcBlobName("blob_123.png"), "blob_123.png");
  for (const name of ["../private", "bad/name", "bad%2fpath", "..", "", " x", "x "]) {
    assert.throws(() => validateUcBlobName(name), /blob name/);
  }
});

test("uploadUcBlob never PUTs a malicious signed URL or blob name", async () => {
  for (const response of [
    { signed_url: "https://127.0.0.1/up/a", blob_name: "good" },
    { signed_url: "https://d.moveinwater.com.evil.test/up/a", blob_name: "good" },
    { signed_url: "https://d.moveinwater.com/not-up/a", blob_name: "good" },
    { signed_url: "https://d.moveinwater.com/up/a", blob_name: "../bad" },
  ]) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return Response.json(response);
    }) as unknown as typeof fetch;
    const blob = await uploadUcBlob(
      { bytes: Buffer.from("img"), contentType: "image/png" },
      { jwt: "j", uid: "u", fetchImpl }
    );
    assert.equal(blob, null);
    assert.equal(calls.length, 1);
  }
});

test("uploadUcBlob refuses signed PUT redirects and unreadable or redirected blobs", async () => {
  for (const rejectedStep of ["PUT", "HEAD"] as const) {
    const calls: Array<{ method: string; redirect?: RequestRedirect }> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const method = init.method || "GET";
      calls.push({ method, redirect: init.redirect });
      if (method === "POST") {
        return Response.json({ signed_url: "https://d.moveinwater.com/up/a", blob_name: "good" });
      }
      return new Response(null, {
        status: method === rejectedStep ? 302 : 200,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    }) as unknown as typeof fetch;
    const blob = await uploadUcBlob(
      { bytes: Buffer.from("img"), contentType: "image/png" },
      { jwt: "j", uid: "u", fetchImpl, readyTimeoutMs: 0 }
    );
    assert.equal(blob, null);
    assert.equal(calls.find((call) => call.method === rejectedStep)?.redirect, "error");
    assert.equal(
      calls.filter((call) => call.method === "HEAD").length,
      rejectedStep === "HEAD" ? 1 : 0
    );
  }
});

test("uploadUcBlob bounds readiness attempts and stops promptly on abort", async () => {
  let heads = 0;
  const controller = new AbortController();
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    if (init.method === "POST") {
      return Response.json({ signed_url: "https://d.moveinwater.com/up/a", blob_name: "good" });
    }
    if (init.method === "HEAD") {
      heads++;
      return new Response(null, { status: 403 });
    }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const media = { bytes: Buffer.from("img"), contentType: "image/png" };
  assert.equal(
    await uploadUcBlob(media, {
      jwt: "j",
      uid: "u",
      fetchImpl,
      readyTimeoutMs: 20_000,
      sleepImpl: async () => {},
    }),
    null
  );
  assert.ok(heads <= 128, `HEAD attempts: ${heads}`);
  heads = 0;
  const pending = uploadUcBlob(media, {
    jwt: "j",
    uid: "u",
    fetchImpl,
    signal: controller.signal,
    sleepImpl: async () => new Promise<void>(() => {}),
  });
  // Move the abort into the sleep after the first HEAD; no real timer/network.
  queueMicrotask(() => controller.abort());
  assert.equal(await pending, null);
  assert.ok(heads <= 1);
});

test("uploadUcBlob bounds a hung readiness HEAD even if the mock ignores abort", async () => {
  let pollSignal: AbortSignal | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    if (init.method === "POST") {
      return Response.json({ signed_url: "https://d.moveinwater.com/up/a", blob_name: "good" });
    }
    if (init.method === "PUT") return new Response(null, { status: 200 });
    pollSignal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
  const result = await uploadUcBlob(
    { bytes: Buffer.from("x"), contentType: "image/png" },
    { jwt: "j", uid: "u", fetchImpl, readyTimeoutMs: 0, sleepImpl: async () => {} }
  );
  assert.equal(result, null);
  assert.equal(pollSignal?.aborted, true);
});

test("extractCurrentTurnMedia counts malformed requested parts so the executor can fail closed", () => {
  const missing = extractCurrentTurnMedia([
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "" } },
        { type: "file", file: null },
        { type: "input_file" },
      ],
    },
  ]);
  assert.equal(missing.requestedMediaCount, 3);
  assert.equal(missing.inline.length + missing.remoteImageUrls.length, 0);
  const remote = extractCurrentTurnMedia([
    { role: "user", content: [{ type: "image_url", image_url: "https://example.com/one.png" }] },
  ]);
  assert.equal(remote.requestedMediaCount, 1);
  assert.deepEqual(remote.remoteImageUrls, ["https://example.com/one.png"]);
});

test("UC media upload warnings do not reveal a signed URL or opaque query", async () => {
  const signedUrl = "https://d.moveinwater.com/up/tok?token=secret%2Fopaque+query";
  const warnings: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    if (init.method === "POST")
      return Response.json({ signed_url: signedUrl, blob_name: "blob_1" });
    if (init.method === "PUT") throw new Error(`transport failed at ${signedUrl}`);
    throw new Error("HEAD must not run");
  }) as unknown as typeof fetch;
  const blob = await uploadUcBlob(
    { bytes: Buffer.from("img"), contentType: "image/png" },
    { jwt: "j", uid: "u", fetchImpl, log: { warn: (_tag, msg) => warnings.push(msg) } }
  );
  assert.equal(blob, null);
  assert.ok(warnings.length > 0);
  assert.ok(!warnings.join(" ").includes(signedUrl));
  assert.ok(!warnings.join(" ").includes("secret%2Fopaque"));
});
