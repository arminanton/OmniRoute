/**
 * Direct, OpenAI-compatible Nous OAuth inference. This executor intentionally
 * does not share the API-key DefaultExecutor: only a validated OAuth bearer may
 * leave this process, and the outbound URL and headers cannot be overridden.
 */
import {
  NOUS_OAUTH_INFERENCE_PSD_KEY,
  validateNousOAuthInferenceBaseUrl,
  isNousOAuthDirectOrConnectProxy,
} from "../config/nousOAuth.ts";
import { getAccessToken } from "../services/tokenRefresh.ts";
import { isProbeContext } from "@/shared/utils/probeOrigin";
import { makeExecutorErrorResult } from "../utils/error.ts";
import {
  getAmbientProxyType,
  hasAmbientProxyContext,
  resolveProxyForRequest,
} from "../utils/proxyFetch.ts";
import {
  BaseExecutor,
  type ExecuteInput,
  type ExecutorExecuteResult,
  type ExecutorLog,
  type ProviderCredentials,
} from "./base.ts";

const PROVIDER = "nous-oauth";
const CHAT_PATH = "/chat/completions";
const FORBIDDEN_CONNECTION_SETTINGS = [
  "apiKey",
  "extraApiKeys",
  "baseUrl",
  "baseUrls",
  "url",
  "endpoint",
  "customUrl",
  "chatPath",
  "requestEndpointPath",
  "responsesBaseUrl",
  "headers",
  "extraHeaders",
  "customHeaders",
  "requestHeaders",
  "customUserAgent",
  "userAgent",
  "targetFormat",
  "authHeader",
] as const;

const own = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function assertCredentials(credentials: ProviderCredentials | null): {
  baseUrl: string;
  accessToken: string;
} {
  if (!credentials || typeof credentials !== "object") {
    throw new Error("Missing Nous OAuth credentials");
  }
  // Reject even an empty API key: a mixed-auth row must not silently choose a
  // credential or fall back to the legacy `nous` API-key connection.
  if (credentials.apiKey != null || own(credentials, "extraApiKeys")) {
    throw new Error("Nous OAuth connection contains API-key credentials");
  }
  if (credentials.requestEndpointPath != null) {
    throw new Error("Nous OAuth connection contains a custom endpoint path");
  }
  const rawCredentials = credentials as Record<string, unknown>;
  if (
    (rawCredentials.authType != null && rawCredentials.authType !== "oauth") ||
    (rawCredentials.provider != null && rawCredentials.provider !== PROVIDER)
  ) {
    throw new Error("Nous OAuth connection has the wrong credential type or provider");
  }
  for (const key of [
    "baseUrl",
    "baseUrls",
    "url",
    "endpoint",
    "customUrl",
    "chatPath",
    "headers",
    "extraHeaders",
    "customHeaders",
    "requestHeaders",
    "customUserAgent",
  ]) {
    if (rawCredentials[key] != null) {
      throw new Error("Nous OAuth connection contains a custom endpoint or headers");
    }
  }
  const psd = credentials.providerSpecificData;
  if (!psd || typeof psd !== "object" || Array.isArray(psd)) {
    throw new Error("Missing Nous OAuth inference base URL");
  }
  for (const key of FORBIDDEN_CONNECTION_SETTINGS) {
    if (own(psd, key)) {
      throw new Error("Nous OAuth connection contains a custom endpoint or headers");
    }
  }
  const baseUrl = validateNousOAuthInferenceBaseUrl(psd[NOUS_OAUTH_INFERENCE_PSD_KEY]);
  if (typeof credentials.accessToken !== "string" || !credentials.accessToken.trim()) {
    throw new Error("Missing Nous OAuth access token");
  }
  if (/[\r\n\0]/.test(credentials.accessToken)) {
    throw new Error("Invalid Nous OAuth access token");
  }
  return { baseUrl, accessToken: credentials.accessToken };
}

/**
 * Recheck each actual URL (including a post-refresh host change) just before
 * dispatch. An inherited edge relay must never receive the OAuth bearer.
 */
function isSafeNousOAuthEgress(url: string): boolean {
  try {
    const type = getAmbientProxyType()?.toLowerCase();
    if (type && type !== "http" && type !== "https") return false;
    const route = resolveProxyForRequest(url);
    // NO_PROXY bypasses environment proxy settings in the shared transport.
    // If a proxy was configured for HTTPS, a bypass must not silently switch
    // this bearer-bearing request to direct egress (or mask a malformed proxy).
    const hasHttpsEnvProxy = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some(
      (name) => typeof process.env[name] === "string" && !!process.env[name]?.trim()
    );
    return (
      (!hasAmbientProxyContext() || route.source === "context") &&
      (route.source !== "direct" || !hasHttpsEnvProxy) &&
      isNousOAuthDirectOrConnectProxy(route.proxyUrl)
    );
  } catch {
    return false;
  }
}

/** Best-effort release; a 401 SSE body or a tee peer may never settle. */
function cancelUpstreamBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Never let a stuck/locked upstream body delay or mask a terminal error.
  }
}

/**
 * Never stream an upstream 401 error body into chatCore: it may never close,
 * causing the error parser to await response.text() forever. Keep only a
 * numeric Retry-After for standard rate/auth classification; all other
 * upstream headers and error text may contain sensitive data.
 */
function terminalUnauthorized(response: Response): Response {
  const retryAfter = response.headers.get("retry-after");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (retryAfter && /^\d{1,7}$/.test(retryAfter)) headers["Retry-After"] = retryAfter;
  cancelUpstreamBody(response);
  return new Response(
    JSON.stringify({
      error: {
        message: "Nous OAuth inference unauthorized",
        type: "authentication_error",
        code: "HTTP_401",
      },
    }),
    { status: 401, headers }
  );
}

/** Never follow even a same-host redirect with the OAuth bearer. */
function isRedirect(response: Response, requestedUrl: string): boolean {
  return (
    (response.status >= 300 && response.status < 400) ||
    response.type === "opaqueredirect" ||
    response.redirected ||
    (Boolean(response.url) && response.url !== requestedUrl)
  );
}

type RefreshAccessToken = (
  credentials: ProviderCredentials,
  log: ExecutorLog | null
) => Promise<Partial<ProviderCredentials> | null>;

export class NousOAuthExecutor extends BaseExecutor {
  // Injectable only for isolated tests. Production always uses the shared
  // connection-ID CAS/lease path, not a local token endpoint or API-key fallback.
  constructor(
    private readonly refreshAccessToken: RefreshAccessToken = (credentials, log) =>
      getAccessToken(PROVIDER, credentials, log)
  ) {
    super(PROVIDER, { id: PROVIDER });
  }

  buildUrl(
    _model: string,
    _stream: boolean,
    _urlIndex = 0,
    credentials: ProviderCredentials | null = null
  ): string {
    return `${assertCredentials(credentials).baseUrl}${CHAT_PATH}`;
  }

  buildHeaders(credentials: ProviderCredentials, stream = true): Record<string, string> {
    const { accessToken } = assertCredentials(credentials);
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
    };
  }

  async refreshCredentials(
    credentials: ProviderCredentials,
    log: ExecutorLog | null = null
  ): Promise<Partial<ProviderCredentials> | null> {
    // DB-bound refresh alone can safely serialize rotations across processes.
    // A missing access token is never silently replaced by a refresh token.
    try {
      assertCredentials(credentials);
      if (
        typeof credentials.connectionId !== "string" ||
        !credentials.connectionId.trim() ||
        typeof credentials.refreshToken !== "string" ||
        !credentials.refreshToken.trim()
      ) {
        return null;
      }
      const refreshed = await this.refreshAccessToken(credentials, log);
      if (!refreshed || typeof refreshed.accessToken !== "string") return null;
      // The refresh path may return a newer DB row's allowed base; validate it
      // before any retry can send its bearer anywhere.
      const merged: ProviderCredentials = { ...credentials, ...refreshed };
      assertCredentials(merged);
      return refreshed;
    } catch {
      log?.warn?.("NOUS_OAUTH", "Nous OAuth refresh failed or returned invalid credentials");
      return null;
    }
  }

  async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    const { credentials, stream, model, body, upstreamExtraHeaders, signal, log } = input;
    let url: string;
    let headers: Record<string, string>;
    if (
      upstreamExtraHeaders != null &&
      (typeof upstreamExtraHeaders !== "object" || Object.keys(upstreamExtraHeaders).length > 0)
    ) {
      return makeExecutorErrorResult(400, "Nous OAuth forbids custom upstream headers", null, "");
    }
    try {
      url = this.buildUrl(model, stream, 0, credentials);
      headers = this.buildHeaders(credentials, stream);
    } catch {
      return makeExecutorErrorResult(400, "Invalid Nous OAuth inference credentials", null, "");
    }
    // The global proxyFetch edge-relay branch forwards Authorization to the
    // operator's relay host. Refuse it BEFORE sending any bearer. Also refuse
    // a malformed/NO_PROXY-bypassed assigned proxy (no silent direct fallback)
    // or a SOCKS transport: only direct/HTTP CONNECT preserves the trusted TLS
    // connection to the first-party inference origin.
    if (!isSafeNousOAuthEgress(url)) {
      return makeExecutorErrorResult(503, "Nous OAuth inference proxy is unavailable", null, "");
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || !model) {
      return makeExecutorErrorResult(400, "Invalid Nous OAuth chat request", null, "");
    }
    // These are never OpenAI chat-completion fields. Do not reflect a caller's
    // mixed credentials or custom headers inside the JSON request body either.
    for (const key of [
      "apiKey",
      "extraApiKeys",
      "accessToken",
      "authorization",
      "Authorization",
      "headers",
    ]) {
      if (own(body, key)) {
        return makeExecutorErrorResult(400, "Invalid Nous OAuth chat request", null, "");
      }
    }
    // Keep caller-supplied tags/session_id intact (Hermes attribution), but do
    // not invent a Hermes version, conversation ID, UA, or TLS fingerprint.
    const transformedBody = { ...(body as Record<string, unknown>), model, stream };
    let bodyString: string;
    try {
      bodyString = JSON.stringify(transformedBody);
      if (typeof bodyString !== "string") throw new Error("Invalid JSON body");
    } catch {
      return makeExecutorErrorResult(400, "Invalid Nous OAuth chat request", null, "");
    }

    // Do not return Authorization in the executor capture: chatCore logs the
    // returned headers. The token is used only by fetch() itself.
    const safeHeaders = { "Content-Type": "application/json", Accept: headers.Accept };
    const send = async (requestUrl: string, requestHeaders: Record<string, string>) => {
      if (!isSafeNousOAuthEgress(requestUrl)) {
        throw new Error("Nous OAuth inference proxy is unavailable");
      }
      return fetch(requestUrl, {
        method: "POST",
        headers: requestHeaders,
        body: bodyString,
        redirect: "manual",
        signal,
      });
    };
    let upstream: Response;
    try {
      upstream = await send(url, headers);
      if (isRedirect(upstream, url)) {
        return makeExecutorErrorResult(502, "Nous OAuth inference redirect rejected", null, url);
      }
      // Probes must not consume a rotating refresh token (#9817).
      if (upstream.status === 401 && !isProbeContext()) {
        const refreshed = await this.refreshCredentials(credentials, log || null);
        if (refreshed) {
          const nextCredentials = { ...credentials, ...refreshed };
          const nextUrl = this.buildUrl(model, stream, 0, nextCredentials);
          const nextHeaders = this.buildHeaders(nextCredentials, stream);
          // Single refresh/resend only. A second 401 goes back to the client;
          // chatCore's Nous-only reactive-refresh guard must not retry it.
          // Do not await cancellation: some 401 SSE bodies never end and a tee
          // branch may wait for its peer indefinitely. The retry must proceed.
          cancelUpstreamBody(upstream);
          upstream = await send(nextUrl, nextHeaders);
          if (isRedirect(upstream, nextUrl)) {
            return makeExecutorErrorResult(
              502,
              "Nous OAuth inference redirect rejected",
              null,
              nextUrl
            );
          }
          url = nextUrl;
          // The shared refresher commits the DB atomically. Never invoke
          // onCredentialsRefreshed here: it could blindly overwrite a newer row.
        }
      }
    } catch {
      return makeExecutorErrorResult(502, "Nous OAuth inference request failed", null, url);
    }

    if (upstream.status === 401) upstream = terminalUnauthorized(upstream);
    return { response: upstream, url, headers: safeHeaders, transformedBody };
  }
}
