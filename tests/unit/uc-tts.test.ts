/**
 * Unit tests for the UC (uncensored.com) TEXT-TO-SPEECH handler.
 *
 * UC TTS is a WebSocket web-app port: a 60s Clerk `__session` JWT (minted from a
 * durable `__client` cookie) authenticates a dedicated voice socket, one `start`
 * frame carries the text + voice, and the server streams base64-encoded MP3
 * chunks in `{data:'...'}` frames (plus `usage_update` quota frames) until it
 * closes. These tests exercise the pure frame builder + the full handler path
 * with a MOCKED WebSocket and a mocked token-mint `fetch` (no live network).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUcTtsStartFrame,
  buildUcTtsWsUrl,
  handleUcTextToSpeech,
  runUcTtsSocket,
  __setUcTtsWebSocketForTesting,
} from "../../open-sse/handlers/uc/ucTts.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const UID = "b03dd963-d0c1-4193-99c9-f5a9d0c66b7f";
const SID = "sess_3EyqBpAa2C25iB8eJzZ2fwdsqLM";

/** Build a fake unsigned JWT with the given claims (base64url payload). */
function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

function psd(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ucClientCookie: "client.jwt.cookie",
    ucSid: SID,
    ucUid: UID,
    ucCookies: { __client: "client.jwt.cookie", __cf_bm: "cf", _cfuvid: "uv" },
    ...extra,
  };
}

/** Mint-token fetch stub so mintUcSessionToken succeeds. */
function tokenFetch(): typeof fetch {
  const jwt = fakeJwt({ uid: UID, sid: SID, exp: Math.floor(Date.now() / 1000) + 60 });
  return (async () =>
    new Response(JSON.stringify({ object: "token", jwt }), {
      status: 200,
    })) as unknown as typeof fetch;
}

/** A failing mint fetch (401) to exercise the auth error path. */
function failingTokenFetch(status = 401): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ errors: [{ message: "invalid" }] }), {
      status,
    })) as unknown as typeof fetch;
}

/** base64 of a tiny MP3-ish payload (ID3 header + bytes). */
function b64(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

/**
 * A minimal fake WebSocket matching the `ws` surface the driver uses: onopen /
 * onmessage / onerror / onclose + send/close. On `send` it replays a scripted set
 * of server frames (each an already-JSON-stringified string) then closes.
 */
function makeFakeWs(frames: string[], opts: { failConnect?: boolean } = {}) {
  return class FakeWS {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readyState = 1;
    constructor(_url: string, _opts?: unknown) {
      if (opts.failConnect) {
        setTimeout(() => this.onerror?.(), 0);
        return;
      }
      setTimeout(() => this.onopen?.(), 0);
    }
    send(_data: string) {
      setTimeout(() => {
        for (const f of frames) this.onmessage?.({ data: f });
        this.onclose?.();
      }, 0);
    }
    close() {
      /* no-op */
    }
  } as unknown as typeof import("ws").default;
}

// ─── buildUcTtsStartFrame / buildUcTtsWsUrl ──────────────────────────────────

test("buildUcTtsStartFrame carries the text, voice, and jwt with fresh uuids", () => {
  const jwt = fakeJwt({ uid: UID, sid: SID });
  const frame = buildUcTtsStartFrame({ text: "hello world", voice: "jade", jwt });
  assert.equal(frame.message_type, "start");
  assert.equal(frame.text, "hello world");
  assert.equal(frame.raw_text, "hello world");
  assert.equal(frame.voice, "jade");
  assert.equal(frame.model, "default");
  assert.equal(frame.token, jwt);
  // thread_id and threadId must be the same uuid.
  assert.equal(frame.thread_id, frame.threadId);
  assert.match(frame.message_id, /^[0-9a-f-]{36}$/);
  assert.notEqual(frame.message_id, frame.turn_anchor_message_id);
});

test("buildUcTtsWsUrl targets the tts-stream host with token in query", () => {
  const url = buildUcTtsWsUrl(UID, "the.jwt.here");
  assert.match(url, /^wss:\/\/tts-stream\.chatuncensored\.ai\//);
  assert.ok(url.includes(encodeURIComponent(UID)));
  assert.ok(url.includes("token=the.jwt.here"));
});

// ─── runUcTtsSocket with a MOCKED WebSocket ──────────────────────────────────

test("runUcTtsSocket accumulates + decodes base64 MP3 data frames", async (t) => {
  // usage_update (ignored for audio) + 2 base64 MP3 chunks, then close.
  const restore = __setUcTtsWebSocketForTesting(
    makeFakeWs([
      JSON.stringify({ type: "usage_update", usage_percent: 13, threshold_crossed: 10 }),
      JSON.stringify({ data: b64([0x49, 0x44, 0x33]) }), // "ID3"
      JSON.stringify({ data: b64([0x04, 0x00, 0xff]) }),
    ])
  );
  t.after(restore);

  const result = await runUcTtsSocket({ jwt: "jwt", uid: UID, text: "hi", voice: "jade" });
  assert.equal(result.error, undefined);
  assert.equal(result.usagePercent, 13);
  assert.deepEqual(Array.from(result.audio), [0x49, 0x44, 0x33, 0x04, 0x00, 0xff]);
});

test("runUcTtsSocket surfaces an error when the socket produces no audio", async (t) => {
  const restore = __setUcTtsWebSocketForTesting(
    makeFakeWs([JSON.stringify({ type: "usage_update", usage_percent: 5, threshold_crossed: 0 })])
  );
  t.after(restore);

  const result = await runUcTtsSocket({ jwt: "jwt", uid: UID, text: "hi", voice: "jade" });
  assert.equal(result.audio.length, 0);
  assert.match(result.error ?? "", /no audio/i);
});

test("runUcTtsSocket resolves with an error on a connect failure", async (t) => {
  const restore = __setUcTtsWebSocketForTesting(makeFakeWs([], { failConnect: true }));
  t.after(restore);

  const result = await runUcTtsSocket({ jwt: "jwt", uid: UID, text: "hi", voice: "jade" });
  assert.equal(result.audio.length, 0);
  assert.ok(result.error);
});

// ─── handleUcTextToSpeech full path (mint + socket) ──────────────────────────

// Owner Directive D3 disables UC speech to conserve AI credits. Keep the
// low-level frame/socket tests above, but the public handler must not mint a
// session token or open a socket, even when a valid UC connection is present.
test("handleUcTextToSpeech rejects a configured request before mint or WebSocket", async (t) => {
  let mintCalls = 0;
  let socketCalls = 0;
  const restore = __setUcTtsWebSocketForTesting(
    class {
      constructor() {
        socketCalls++;
      }
    } as unknown as typeof import("ws").default
  );
  t.after(restore);

  const result = await handleUcTextToSpeech({
    text: "read this aloud",
    voice: "jade",
    credentials: { providerSpecificData: psd() },
    fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      mintCalls++;
      return tokenFetch()(...args);
    }) as typeof fetch,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error ?? "", /disabled by policy/i);
  assert.equal(mintCalls, 0);
  assert.equal(socketCalls, 0);
});

test("handleUcTextToSpeech rejects an empty voice without starting a socket", async () => {
  const result = await handleUcTextToSpeech({
    text: "hi",
    voice: "   ",
    credentials: { providerSpecificData: psd() },
    fetchImpl: tokenFetch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error ?? "", /disabled by policy/i);
});

test("handleUcTextToSpeech rejects an empty input under the same policy", async () => {
  const result = await handleUcTextToSpeech({
    text: "   ",
    credentials: { providerSpecificData: psd() },
    fetchImpl: tokenFetch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error ?? "", /disabled by policy/i);
});

test("handleUcTextToSpeech returns policy 400 before checking missing credentials", async () => {
  const result = await handleUcTextToSpeech({
    text: "hi",
    credentials: { providerSpecificData: {} },
    fetchImpl: tokenFetch(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error ?? "", /disabled by policy/i);
});

test("handleUcTextToSpeech never mints even when Clerk would reject a request", async () => {
  let calls = 0;
  const result = await handleUcTextToSpeech({
    text: "hi",
    credentials: { providerSpecificData: psd() },
    fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return failingTokenFetch(401)(...args);
    }) as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error ?? "", /disabled by policy/i);
  assert.equal(calls, 0);
});
