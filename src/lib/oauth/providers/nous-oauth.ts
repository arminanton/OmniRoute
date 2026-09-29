import { NOUS_OAUTH_CONFIG } from "../constants/oauth";
import {
  NOUS_OAUTH_INFERENCE_PSD_KEY,
  validateNousOAuthInferenceBaseUrl,
} from "@omniroute/open-sse/config/nousOAuth.ts";

const DEFAULT_INFERENCE_URL = "https://inference-api.nousresearch.com/v1";
const PORTAL_ORIGIN = "https://portal.nousresearch.com";

/** Portal bodies may be WAF HTML streams that never end; bound bytes and wall time. */
async function readNousPortalJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty Nous Portal response");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Nous Portal response body timed out")), 5000);
  });
  const decoder = new TextDecoder();
  let text = "";
  let count = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      count += chunk.value.byteLength;
      if (count > 16_384) throw new Error("Nous Portal response body exceeded 16 KiB");
      text += decoder.decode(chunk.value, { stream: true });
    }
    const parsed: unknown = JSON.parse(text + decoder.decode());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid Nous Portal response");
    }
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

function assertNousPortalResponse(response: Response): void {
  if (response.redirected || (response.url && new URL(response.url).origin !== PORTAL_ORIGIN) ||
      (response.status >= 300 && response.status < 400)) {
    throw new Error("Nous Portal OAuth endpoint redirected unexpectedly");
  }
}


/** Hermes CLI-compatible public device client. This is not official third-party SSO. */
export const nousOAuth = {
  config: NOUS_OAUTH_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config: typeof NOUS_OAUTH_CONFIG) => {
    const response = await fetch(config.deviceCodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: config.clientId, scope: config.scope }),
      signal: AbortSignal.timeout(20_000),
      redirect: "manual",
    });
    assertNousPortalResponse(response);
    if (!response.ok) throw new Error(`Nous device authorization failed (${response.status})`);
    const data = await readNousPortalJson(response);
    if (!data || typeof data !== "object" ||
        typeof data.device_code !== "string" || !data.device_code ||
        typeof data.user_code !== "string" || !data.user_code ||
        typeof data.verification_uri !== "string" ||
        typeof data.verification_uri_complete !== "string" ||
        typeof data.expires_in !== "number" || !Number.isSafeInteger(data.expires_in) ||
        data.expires_in < 1 || data.expires_in > 3600 ||
        typeof data.interval !== "number" || !Number.isSafeInteger(data.interval) ||
        data.interval < 1 || data.interval > 300) {
      throw new Error("Nous device authorization returned incomplete data");
    }
    for (const url of [data.verification_uri, data.verification_uri_complete]) {
      // A network response must not make the dashboard open an attacker-controlled login page.
      const parsed = new URL(url);
      if (parsed.origin !== PORTAL_ORIGIN || parsed.username || parsed.password) {
        throw new Error("Nous device verification URL is not a trusted portal URL");
      }
    }
    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete,
      expires_in: Number(data.expires_in),
      interval: Number(data.interval),
    };
  },
  pollToken: async (config: typeof NOUS_OAUTH_CONFIG, deviceCode: string) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.clientId,
        device_code: deviceCode,
      }),
      signal: AbortSignal.timeout(20_000),
      redirect: "manual",
    });
    // A redirect is not an OAuth response; do not follow to a third-party host.
    assertNousPortalResponse(response);
    let data: Record<string, unknown>;
    try {
      data = await readNousPortalJson(response);
    } catch {
      data = { error: "invalid_response" };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      data = { error: "invalid_response" };
    }
    // A WAF challenge or a temporary edge error is NOT an authorization denial.
    if (response.status === 408 || response.status === 429 || response.status >= 500 ||
        (response.status === 403 && response.headers.get("x-vercel-mitigated"))) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        ok: false,
        data: { error: "temporarily_unavailable", retry_after: Number.isFinite(retryAfter) ? retryAfter : undefined },
      };
    }
    return { ok: response.ok, data };
  },
  mapTokens: (tokens: Record<string, unknown>) => {
    if (typeof tokens.access_token !== "string" || !tokens.access_token ||
        typeof tokens.refresh_token !== "string" || !tokens.refresh_token ||
        !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0) {
      throw new Error("Nous token response did not include usable rotating credentials");
    }
    const inferenceBaseUrl = tokens.inference_base_url == null || tokens.inference_base_url === ""
      ? DEFAULT_INFERENCE_URL
      : validateNousOAuthInferenceBaseUrl(tokens.inference_base_url);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: Number(tokens.expires_in),
      providerSpecificData: { [NOUS_OAUTH_INFERENCE_PSD_KEY]: inferenceBaseUrl },
    };
  },
};
