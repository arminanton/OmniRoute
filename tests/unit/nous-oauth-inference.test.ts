import test from "node:test";
import assert from "node:assert/strict";

import {
  NOUS_OAUTH_INFERENCE_BASE_URLS,
  NOUS_OAUTH_INFERENCE_PSD_KEY,
  validateNousOAuthInferenceBaseUrl,
} from "../../open-sse/config/nousOAuth.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.ts";
import { getCredentialRefreshExecutor } from "../../open-sse/executors/credential.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import { NousOAuthExecutor } from "../../open-sse/executors/nous-oauth.ts";
import type { ProviderCredentials } from "../../open-sse/executors/base.ts";
import { runAsProbe } from "../../src/shared/utils/probeOrigin.ts";

const originalFetch = globalThis.fetch;
const base = NOUS_OAUTH_INFERENCE_BASE_URLS[0];
const validCredentials = (): ProviderCredentials => ({
  accessToken: "oauth-only-access",
  refreshToken: "oauth-refresh",
  connectionId: "oauth-connection",
  providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: base },
});
const input = (credentials: ProviderCredentials = validCredentials(), stream = false) => ({
  model: "Hermes-4-70B",
  body: {
    model: "Hermes-4-405B",
    messages: [{ role: "user", content: "Hello" }],
    tags: ["product=hermes-agent", "client=hermes-client-v-real"],
    session_id: "caller-supplied-session",
  },
  stream,
  credentials,
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Nous OAuth has an isolated ID, OAuth category and nso alias; nous remains API-key/default", async () => {
  assert.equal(getRegistryEntry("nous-oauth")?.alias, "nso");
  assert.equal(getRegistryEntry("nso")?.id, "nous-oauth");
  assert.equal(getRegistryEntry("nso")?.authType, "oauth");
  assert.equal(getRegistryEntry("nous")?.id, "nous-research");
  assert.equal(getRegistryEntry("nous")?.authType, "apikey");
  assert.ok(hasSpecializedExecutor("nous-oauth"));
  assert.ok(hasSpecializedExecutor("nso"));
  assert.ok((await getExecutor("nous-oauth")) instanceof NousOAuthExecutor);
  assert.ok((await getExecutor("nso")) instanceof NousOAuthExecutor);
  assert.ok((await getCredentialRefreshExecutor("nous-oauth")) instanceof NousOAuthExecutor);
  assert.ok((await getCredentialRefreshExecutor("nso")) instanceof NousOAuthExecutor);
  assert.ok((await getExecutor("nous")) instanceof DefaultExecutor);
});

test("inference base verifier accepts ONLY exact first-party HTTPS /v1 bases", () => {
  for (const candidate of NOUS_OAUTH_INFERENCE_BASE_URLS) {
    assert.equal(validateNousOAuthInferenceBaseUrl(candidate), candidate);
  }
  for (const candidate of [
    undefined,
    null,
    "",
    "https://inference-api.nousresearch.com/v1/",
    "http://inference-api.nousresearch.com/v1",
    "https://inference-api.nousresearch.com:443/v1",
    "https://user@inference-api.nousresearch.com/v1",
    "https://inference-api.nousresearch.com/v1?evil=1",
    "https://inference-api.nousresearch.com/v1#evil",
    "https://inference-api.nousresearch.com/v1/../v1",
    "https://inference-api.nousresearch.com.evil.test/v1",
    "https://welcome-api.nousresearch.com/v1/chat/completions",
  ]) {
    assert.throws(() => validateNousOAuthInferenceBaseUrl(candidate));
  }
});

test("direct OAuth fetch fixes URL, preserves model and caller tags/session, streams SSE without Firefox headers", async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), `${base}/chat/completions`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer oauth-only-access");
    assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
    assert.equal(new Headers(init?.headers).get("user-agent"), null);
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.model, "Hermes-4-70B");
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.tags, ["product=hermes-agent", "client=hermes-client-v-real"]);
    assert.equal(sent.session_id, "caller-supplied-session");
    return new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  const executor = new NousOAuthExecutor();
  const result = await executor.execute(input(validCredentials(), true));
  assert.ok(!(result instanceof Response));
  assert.equal(result.response.status, 200);
  assert.match(await result.response.text(), /data: \[DONE\]/);
  assert.equal(result.url, `${base}/chat/completions`);
  assert.equal(result.headers?.["Content-Type"], "application/json");
  assert.equal(JSON.stringify(result.headers).includes("oauth-only-access"), false);
  assert.equal(calls, 1);
});

test("trusted welcome-api base selects its own fixed chat URL", async () => {
  const welcome = NOUS_OAUTH_INFERENCE_BASE_URLS[1];
  const credentials = validCredentials();
  credentials.providerSpecificData![NOUS_OAUTH_INFERENCE_PSD_KEY] = welcome;
  const executor = new NousOAuthExecutor();
  assert.equal(
    executor.buildUrl("Hermes-4-405B", false, 0, credentials),
    `${welcome}/chat/completions`
  );
  globalThis.fetch = async (url) => {
    assert.equal(String(url), `${welcome}/chat/completions`);
    return Response.json({ choices: [], model: "Hermes-4-70B" });
  };
  const result = await executor.execute(input(credentials));
  assert.ok(!(result instanceof Response));
  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json()).model, "Hermes-4-70B");
});

test("missing base/token, any key conflict, custom endpoint and custom headers fail before fetch", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not fetch");
  };
  const bad: ProviderCredentials[] = [
    { accessToken: "access" },
    { providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: base } },
    { ...validCredentials(), apiKey: "secret-api-key" },
    { ...validCredentials(), apiKey: "" },
    { ...validCredentials(), authType: "apikey" } as ProviderCredentials,
    { ...validCredentials(), provider: "nous-research" } as ProviderCredentials,
    { ...validCredentials(), requestEndpointPath: "/v1/responses" },
    {
      ...validCredentials(),
      providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: "https://evil.example/v1" },
    },
    {
      ...validCredentials(),
      providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: base, extraApiKeys: ["secret"] },
    },
    {
      ...validCredentials(),
      providerSpecificData: {
        [NOUS_OAUTH_INFERENCE_PSD_KEY]: base,
        baseUrl: "https://evil.example",
      },
    },
    {
      ...validCredentials(),
      providerSpecificData: {
        [NOUS_OAUTH_INFERENCE_PSD_KEY]: base,
        customHeaders: { Authorization: "Bearer secret" },
      },
    },
    {
      ...validCredentials(),
      providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: base, customUserAgent: "custom" },
    },
  ];
  for (const credentials of bad) {
    const result = await new NousOAuthExecutor().execute(input(credentials));
    assert.ok(!(result instanceof Response));
    assert.equal(result.response.status, 400);
    const error = await result.response.text();
    assert.equal(error.includes("secret"), false);
  }
  const upstreamHeadersResult = await new NousOAuthExecutor().execute({
    ...input(),
    upstreamExtraHeaders: { "X-Secret": "secret" },
  });
  assert.ok(!(upstreamHeadersResult instanceof Response));
  assert.equal(upstreamHeadersResult.response.status, 400);
  assert.equal(calls, 0);
});

test("a redirect is rejected, never followed, and does not expose its Location", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 307, headers: { Location: "https://evil.example/steal" } });
  };
  const result = await new NousOAuthExecutor().execute(input());
  assert.ok(!(result instanceof Response));
  assert.equal(result.response.status, 502);
  assert.equal((await result.response.text()).includes("evil.example"), false);
  assert.equal(calls, 1);
});

test("a 401 uses exactly one DB-bound refresh and resend; a second 401 never retries", async () => {
  const requests: string[] = [];
  let refreshes = 0;
  let blindWrites = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), `${base}/chat/completions`);
    requests.push(new Headers(init?.headers).get("authorization") || "");
    return new Response("Unauthorized", { status: 401 });
  };
  const executor = new NousOAuthExecutor(async (credentials) => {
    refreshes++;
    assert.equal(credentials.connectionId, "oauth-connection");
    assert.equal(credentials.refreshToken, "oauth-refresh");
    return {
      accessToken: "fresh-oauth-only",
      refreshToken: "new-oauth-refresh",
      providerSpecificData: credentials.providerSpecificData,
    };
  });
  const result = await executor.execute({
    ...input(),
    onCredentialsRefreshed: async () => {
      blindWrites++;
    },
  });
  assert.ok(!(result instanceof Response));
  assert.equal(result.response.status, 401);
  assert.deepEqual(requests, ["Bearer oauth-only-access", "Bearer fresh-oauth-only"]);
  assert.equal(refreshes, 1);
  assert.equal(blindWrites, 0);
});

test("a non-ending 401 body cannot block the single refreshed resend", async () => {
  let calls = 0;
  let canceled = false;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      const neverEnding = new ReadableStream({
        cancel() {
          canceled = true;
          return new Promise<void>(() => {});
        },
      });
      return new Response(neverEnding, { status: 401 });
    }
    return Response.json({ choices: [], model: "Hermes-4-70B" });
  };
  const executor = new NousOAuthExecutor(async (credentials) => ({
    accessToken: "fresh-bearer",
    providerSpecificData: credentials.providerSpecificData,
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      executor.execute(input()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("401 refresh/resend stalled")), 500);
      }),
    ]);
    assert.ok(!(result instanceof Response));
    assert.equal(result.response.status, 200);
    assert.equal(calls, 2);
    assert.equal(canceled, true);
  } finally {
    if (timer) clearTimeout(timer);
  }
});

test("terminal 401 never awaits an endless upstream error body (with abort)", async () => {
  for (const refreshable of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    let cancels = 0;
    let refreshes = 0;
    globalThis.fetch = async () => {
      calls++;
      if (refreshable && calls === 2) controller.abort();
      return new Response(
        new ReadableStream({
          cancel() {
            cancels++;
            return new Promise<void>(() => {});
          },
        }),
        {
          status: 401,
          headers: { "Retry-After": "5", "X-Secret": "do-not-reflect" },
        }
      );
    };
    const executor = new NousOAuthExecutor(async (credentials) => {
      refreshes++;
      return {
        accessToken: "rotated-token",
        providerSpecificData: credentials.providerSpecificData,
      };
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        executor.execute({
          ...input(),
          signal: controller.signal,
          credentials: refreshable
            ? validCredentials()
            : { ...validCredentials(), refreshToken: undefined },
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("endless 401 body stalled")), 500);
        }),
      ]);
      assert.ok(!(result instanceof Response));
      assert.equal(result.response.status, 401);
      assert.equal(result.response.headers.get("retry-after"), "5");
      assert.equal(result.response.headers.get("x-secret"), null);
      assert.equal((await result.response.json()).error.code, "HTTP_401");
      assert.equal(calls, refreshable ? 2 : 1);
      assert.equal(refreshes, refreshable ? 1 : 0);
      assert.equal(cancels, refreshable ? 2 : 1);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
});

test("a refreshed bearer bound to an untrusted host is never sent", async () => {
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push(`${String(url)} ${new Headers(init?.headers).get("authorization")}`);
    return new Response("Unauthorized", { status: 401 });
  };
  const executor = new NousOAuthExecutor(async () => ({
    accessToken: "new-secret-token",
    providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: "https://evil.example/v1" },
  }));
  const result = await executor.execute(input());
  assert.ok(!(result instanceof Response));
  assert.equal(result.response.status, 401);
  assert.deepEqual(requests, [`${base}/chat/completions Bearer oauth-only-access`]);
});

test("probe-origin 401 never consumes a rotating OAuth refresh token", async () => {
  let requests = 0;
  let refreshes = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response("Unauthorized", { status: 401 });
  };
  const executor = new NousOAuthExecutor(async () => {
    refreshes++;
    return { accessToken: "probe-should-not-refresh" };
  });
  const result = await runAsProbe(() => executor.execute(input()));
  assert.ok(!(result instanceof Response));
  assert.equal(result.response.status, 401);
  assert.equal(requests, 1);
  assert.equal(refreshes, 0);
});

test("401 without a DB connection or refresh token does not refresh or fall back", async () => {
  let requests = 0;
  let refreshes = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response("Unauthorized", { status: 401 });
  };
  const executor = new NousOAuthExecutor(async () => {
    refreshes++;
    return { accessToken: "should-not-appear" };
  });
  const credentials = validCredentials();
  delete credentials.connectionId;
  const result = await executor.execute(input(credentials));
  assert.ok(!(result instanceof Response));
  assert.equal(result.response.status, 401);
  assert.equal(requests, 1);
  assert.equal(refreshes, 0);
});
