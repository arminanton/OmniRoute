/**
 * Web-Cookie + NoAuth executor wrapper contract sweep.
 *
 * Why this file exists
 * --------------------
 * `open-sse/handlers/chatCore.ts` reads `res.response.status`, `res.response.headers`,
 * and uses `res.url` / `res.transformedBody` to classify upstream responses
 * (see chatCore.ts:3937–4486, BaseExecutor.execute() at base.ts:1146).
 *
 * An executor that returns a raw `Response` instead of the wrapper shape
 * `{response, url, headers, transformedBody}` causes `res.response.status` to
 * throw `Cannot read properties of undefined (reading 'status')`. That JS
 * TypeError was then surfaced as a 502 via `formatProviderError` in
 * `open-sse/utils/error.ts:496`, and showed up to the client as
 * `[502]: Cannot read properties of undefined (reading 'status')`.
 *
 * The duckduckgo-web executor was the first known case. To prevent any
 * future executor from regressing on the same contract, this sweep test
 * imports every executor in `WEB_COOKIE_PROVIDERS` + `NOAUTH_PROVIDERS`
 * (including newly added entries), calls `execute()` with a minimal input,
 * and asserts the wrapper shape. Tests use empty credentials, explicit
 * in-memory 401 fixtures, or the pre-aborted path. Socket, DNS, subprocess,
 * and native TLS tripwires fail even if an executor swallows the error.
 *
 * If this file ever flags a missing executor, the fix is in the executor
 * — the contract is the executor's responsibility.
 */
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import dns from "node:dns";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { TlsClient } from "../../open-sse/utils/tlsClient.ts";
import { tlsClientModule as grokTls } from "../../open-sse/services/grokTlsClient.ts";
import { tlsClientModule as perplexityTls } from "../../open-sse/services/perplexityTlsClient.ts";
import { tlsClientModule as claudeTls } from "../../open-sse/services/claudeTlsClient.ts";
import { tlsClientModule as lmarenaTls } from "../../open-sse/services/lmarenaTlsClient.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";
import { WEB_COOKIE_PROVIDERS, NOAUTH_PROVIDERS } from "../../src/shared/constants/providers.ts";

type WebCookieId = keyof typeof WEB_COOKIE_PROVIDERS;
type NoauthId = keyof typeof NOAUTH_PROVIDERS;

const WEB_COOKIE_IDS = Object.keys(WEB_COOKIE_PROVIDERS) as WebCookieId[];
const NOAUTH_IDS = Object.keys(NOAUTH_PROVIDERS) as NoauthId[];

/**
 * Empty credentials exercise local validation where available. Providers that
 * accept guest/empty credentials get only the exact denied requests below.
 * Native TLS calls have separate seams; a global fetch mock alone is not enough.
 */
const EXPECTED_REQUESTS: Record<string, string[]> = {
  "grok-web": ["tls POST https://grok.com/rest/app-chat/conversations/new"],
  "perplexity-web": ["tls POST https://www.perplexity.ai/rest/sse/perplexity_ask"],
  "blackbox-web": [
    "fetch GET https://app.blackbox.ai/api/auth/session",
    "fetch POST https://app.blackbox.ai/api/chat",
  ],
  "copilot-web": ["fetch POST https://copilot.microsoft.com/c/api/start"],
  "poe-web": ["fetch POST https://www.poe.com/api/gql_POST"],
  "venice-web": ["fetch POST https://venice.ai/api/chat"],
  "v0-vercel-web": ["fetch POST https://v0.dev/api/chat"],
  // Catalog lookup precedes the executor's abort check. Simulate fetch's abort locally.
  "duckduckgo-web": ["fetch GET https://duck.ai/duckchat/v1/models"],
};

const DENIED_BODY = JSON.stringify({ error: { message: "offline fixture: unauthorized" } });

async function withOfflineExecutor(
  t: TestContext,
  provider: string,
  run: () => Promise<void>
) {
  const expected = EXPECTED_REQUESTS[provider] ?? [];
  const requests: string[] = [];
  const unexpected: string[] = [];
  const patches: { mock: { restore: () => void } }[] = [];
  const tlsModules = [grokTls, perplexityTls, claudeTls, lmarenaTls];
  const deny = (channel: string) => (): never => {
    unexpected.push(channel);
    throw new Error(`[${provider}] unexpected unmocked transport: ${channel}`);
  };
  const record = (channel: string, url: string, method: string) => {
    const request = `${channel} ${method} ${url}`;
    const next = expected[requests.length];
    requests.push(request);
    if (request !== next) deny(request)();
  };

  try {
    // Tripwires also record attempts: an executor catch must not hide real I/O.
    patches.push(t.mock.method(net.Socket.prototype, "connect", deny("socket.connect")));
    patches.push(t.mock.method(net, "connect", deny("net.connect")));
    patches.push(t.mock.method(net, "createConnection", deny("net.createConnection")));
    patches.push(t.mock.method(tls, "connect", deny("tls.connect")));
    patches.push(t.mock.method(dgram, "createSocket", deny("dgram.createSocket")));
    for (const method of ["lookup", "resolve", "resolve4", "resolve6"] as const) {
      patches.push(t.mock.method(dns, method, deny(`dns.${method}`)));
      patches.push(t.mock.method(dns.promises, method, deny(`dns.promises.${method}`)));
    }
    for (const method of ["request", "get"] as const) {
      patches.push(t.mock.method(http, method, deny(`http.${method}`)));
      patches.push(t.mock.method(https, method, deny(`https.${method}`)));
    }
    for (const method of [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const) {
      patches.push(t.mock.method(childProcess, method, deny(`child_process.${method}`)));
    }
    patches.push(t.mock.method(TlsClient.prototype, "fetch", deny("native TLS client")));
    syncBuiltinESMExports();

    patches.push(
      t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        record("fetch", url, init?.method ?? (input instanceof Request ? input.method : "GET"));
        if (provider === "duckduckgo-web") {
          const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          if (!signal?.aborted) deny("DuckDuckGo fetch without pre-aborted signal")();
          throw signal.reason;
        }
        return new Response(DENIED_BODY, {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    for (const module of tlsModules) {
      module.__setTlsFetchOverrideForTesting(async (url, options) => {
        // Only the current provider's own TLS seam may consume its expected request.
        if (
          (provider !== "grok-web" || module !== grokTls) &&
          (provider !== "perplexity-web" || module !== perplexityTls)
        ) {
          deny(`native TLS ${url}`)();
        }
        record("tls", url, options.method ?? "GET");
        return {
          status: 401,
          headers: new Headers({ "Content-Type": "application/json" }),
          text: DENIED_BODY,
          body: null,
        };
      });
    }
    await run();
  } finally {
    for (const module of tlsModules) module.__setTlsFetchOverrideForTesting(null);
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports();
    assert.deepEqual(unexpected, [], `[${provider}] no unmocked transport attempts`);
    assert.deepEqual(requests, expected, `[${provider}] exact offline fixture requests`);
  }
}

const VALID_BODY = {
  model: "test",
  messages: [{ role: "user", content: "ping" }],
};

/**
 * Asserts that `result` has the executor wrapper contract shape:
 *   { response: Response, url: string, headers: object, transformedBody: unknown }
 *
 * The contract is what `open-sse/handlers/chatCore.ts` and
 * `BaseExecutor.execute()` (open-sse/executors/base.ts:1146) depend on.
 */
function assertExecutorWrapperShape(
  result: unknown,
  provider: string
): asserts result is {
  response: Response;
  url: string;
  headers: Record<string, unknown>;
  transformedBody: unknown;
} {
  assert.ok(
    result && typeof result === "object",
    `[${provider}] execute() must return an object, not ${typeof result}`
  );
  const r = result as Record<string, unknown>;
  assert.ok(
    r.response instanceof Response,
    `[${provider}] result.response must be a Response (got ${typeof r.response})`
  );
  assert.equal(typeof r.url, "string", `[${provider}] result.url must be a string`);
  assert.ok(
    r.headers && typeof r.headers === "object",
    `[${provider}] result.headers must be an object`
  );
  // transformedBody may be null/undefined/object; just check it doesn't
  // throw when accessed.
  void r.transformedBody;
  // Critical: r.response.status must be reachable without throwing
  // — this is the exact property read that the duckduckgo-web bug
  // (#3106) crashed on.
  const status = (r.response as Response).status;
  assert.ok(
    Number.isInteger(status) && status >= 100 && status < 600,
    `[${provider}] result.response.status must be a valid HTTP status, got ${status}`
  );
}

describe("web-cookie + noauth executor wrapper contract sweep", { concurrency: false }, () => {
  describe("WEB_COOKIE_PROVIDERS", () => {
    for (const providerId of WEB_COOKIE_IDS) {
      it(`${providerId} executor returns wrapper shape`, async (t) => {
        await withOfflineExecutor(t, providerId, async () => {
          const executor = await getExecutor(providerId);
          assert.ok(executor, `[${providerId}] getExecutor must return an executor`);

          const result = await executor.execute({
            model: providerId,
            body: VALID_BODY,
            stream: false,
            credentials: { apiKey: "" },
            signal: null,
          } as never);

          assertExecutorWrapperShape(result, providerId);
          if (providerId === "tencent-aistudio-web") {
            assert.equal(result.response.status, 401, "missing Tencent cookie must reject locally");
            assert.equal(result.url, "https://aistudio.tencent.ai/api/chat/HunyuanDefault");
            assert.deepEqual(result.headers, {});
            assert.strictEqual(result.transformedBody, VALID_BODY);
          }
          if (EXPECTED_REQUESTS[providerId]) {
            assert.equal(result.response.status, providerId === "copilot-web" ? 502 : 401);
          }

          // Result should never be a JS TypeError. Real executor returns
          // a proper Response with a JSON error body for invalid creds.
          // If a regression introduces a raw Response return, the shape
          // assertion above will fail.
          const body = await result.response.text();
          // Most executors return JSON error bodies for invalid creds.
          // We don't require JSON, but we DO require the body to be a
          // non-empty string (not the literal "[object Response]" or
          // a TypeError stack trace).
          assert.ok(body.length > 0, `[${providerId}] response body must be non-empty`);
          assert.notEqual(body, "[object Response]", `[${providerId}] body must not stringify Response`);
          if (providerId === "tencent-aistudio-web") {
            assert.equal(JSON.parse(body).error.code, "missing_cookie");
          }
          // And it must NOT be the duckduckgo-web regression signature.
          assert.doesNotMatch(
            body,
            /Cannot read properties of undefined \(reading 'status'\)/,
            `[${providerId}] must not surface the chatCore-side TypeError`
          );
        });
      });
    }
  });

  describe("NOAUTH_PROVIDERS (credential-free targets)", () => {
    // Only noauth providers that should be probed without creds:
    // duckduckgo-web and veoaifree-web. opencode/notice have dedicated
    // executor tests already (executor-opencode.test.ts / executor-notice.test.ts).
    const TARGETS = NOAUTH_IDS.filter((id) => id === "duckduckgo-web" || id === "veoaifree-web");

    for (const providerId of TARGETS) {
      it(`${providerId} noauth executor returns wrapper shape`, async (t) => {
        await withOfflineExecutor(t, providerId, async () => {
          const executor = await getExecutor(providerId);
          assert.ok(executor, `[${providerId}] getExecutor must return an executor`);

          // Keep the abort branch. Any preliminary fetch is also mocked and counted.
          const controller = new AbortController();
          controller.abort();

          const result = await executor.execute({
            model: providerId,
            body: VALID_BODY,
            stream: false,
            credentials: { apiKey: "" },
            signal: controller.signal,
          } as never);

          // duckduckgo-web may legitimately short-circuit with a bare
          // 499 Response on a pre-aborted signal; chatCore's
          // normalizeExecutorResult already accepts both shapes. Only
          // insist on the full wrapper for executors that are expected
          // to produce one.
          if (result instanceof Response) {
            assert.equal(providerId, "duckduckgo-web", "only DuckDuckGo's abort path is bare");
            assert.equal(result.status, 499, "DuckDuckGo must preserve cancellation status");
            assert.ok(
              result.status >= 100 && result.status < 600,
              `[${providerId}] bare Response must have a valid HTTP status, got ${result.status}`
            );
          } else {
            assertExecutorWrapperShape(result, providerId);
          }
          const response = result instanceof Response ? result : result.response;
          assert.equal(response.status, providerId === "duckduckgo-web" ? 499 : 502);
          const body = await response.text();
          assert.ok(body.length > 0, `[${providerId}] response body must be non-empty`);
          assert.notEqual(body, "[object Response]", `[${providerId}] body must not stringify Response`);
          assert.doesNotMatch(
            body,
            /Cannot read properties of undefined \(reading 'status'\)/,
            `[${providerId}] must not surface the chatCore-side TypeError`
          );
        });
      });
    }
  });
});
