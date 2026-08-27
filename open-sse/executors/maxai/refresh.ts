/**
 * MaxAI access-token refresh through one signed HTTP attempt.
 *
 * MaxAI issues an approximately 24 hour `accessToken` and an approximately one
 * year `refreshToken`; both stages have been exercised live.
 * The web app refreshes the access token by POSTing the refresh token to
 * `/oauth/refresh_access_token` (web-app chunk 86042, `refreshAccessToken`). That
 * endpoint carries the SAME per-request `X-Authorization` signature as every other
 * MaxAI call (see ./signing.ts). OmniRoute sends it through the required Windows
 * Firefox 150 client profile and the operator's configured network route.
 *
 * The refresh token is minted by email login or manual import and stored with the
 * connection. Normal refresh mints the next daily access token without a browser;
 * an upstream auth rejection still surfaces a reauthentication condition.
 *
 * Request shape (byte-faithful to the web app):
 *   POST https://api.maxai.me/oauth/refresh_access_token
 *     Authorization: Bearer <refreshToken>      // the REFRESH token, not access
 *     noAuthLogout: true
 *     X-Authorization + X-App/X-Browser headers  // standard signing
 *   body: {"app":"maxai_webapp"}                 // the app's `params` -> JSON body
 *   -> 200 { data: { access_token } }            // a fresh ~24h access JWT
 *
 * The signed path is the BARE pathname (no query string); the `app` field travels
 * in the body. `user_id` folds into the signature and is read from the refresh
 * token's own JWT subject (per the web app), falling back to a provided userId.
 */
import { buildMaxaiSignedHeaders } from "./signing.ts";
import { maxaiStaticHeaders, MAXAI_BASE_URL } from "./protocol.ts";
import { userIdFromJwt, accessTokenExpiry } from "./credentials.ts";
import { refreshMaxaiConstants } from "./constantsStore.ts";
import { createHash } from "node:crypto";
import type { MaxaiCredential } from "./credentials.ts";

export const MAXAI_REFRESH_PATH = "/oauth/refresh_access_token";

/** How close to expiry (seconds) an access token may be before we refresh it. */
export const MAXAI_REFRESH_MARGIN_SECONDS = 60 * 60; // 1h
export const MAXAI_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
export const MAXAI_REFRESH_TIMEOUT_MS = 30_000;
export const MAXAI_REFRESH_FAILURES_MAX = 256;

const inFlightRefreshes = new Map<string, Promise<MaxaiRefreshResult>>();
const refreshFailures = new Map<string, { until: number; result: MaxaiRefreshResult }>();

function refreshGenerationKey(scope: string, refreshToken: string): string {
  const generation = createHash("sha256").update(refreshToken).digest("hex").slice(0, 24);
  return `${scope}:${generation}`;
}

function callerAbortResult(): MaxaiRefreshResult {
  return { ok: false, status: 0, error: "refresh wait aborted" };
}

function refreshTimeoutResult(): MaxaiRefreshResult {
  return { ok: false, status: 0, error: "refresh timed out" };
}

function pruneRefreshFailures(nowMs: number): void {
  for (const [key, failure] of refreshFailures) {
    if (failure.until <= nowMs) refreshFailures.delete(key);
  }
}

function enforceRefreshFailureLimit(): void {
  while (refreshFailures.size > MAXAI_REFRESH_FAILURES_MAX) {
    let oldestKey: string | undefined;
    let oldestUntil = Number.POSITIVE_INFINITY;
    for (const [key, failure] of refreshFailures) {
      if (
        failure.until < oldestUntil ||
        (failure.until === oldestUntil && (oldestKey === undefined || key < oldestKey))
      ) {
        oldestKey = key;
        oldestUntil = failure.until;
      }
    }
    if (oldestKey === undefined) return;
    refreshFailures.delete(oldestKey);
  }
}

async function waitForRefresh(
  shared: Promise<MaxaiRefreshResult>,
  signal: AbortSignal | null | undefined
): Promise<MaxaiRefreshResult> {
  if (!signal) return shared;
  if (signal.aborted) return callerAbortResult();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(callerAbortResult());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export interface MaxaiRefreshInput {
  refreshToken: string;
  deviceId: string;
  /** Optional explicit user id; defaults to the refresh token's JWT subject. */
  userId?: string;
  signal?: AbortSignal | null;
  /** Injectable fetch for tests (defaults to the ambient patched fetch). */
  fetchImpl?: typeof fetch;
}

export interface MaxaiRefreshResult {
  ok: boolean;
  accessToken?: string;
  /** Replacement refresh token when MaxAI rotates it. */
  refreshToken?: string;
  /** access token expiry (epoch seconds), when a token was minted. */
  expiresAt?: number;
  status: number;
  error?: string;
}

/** Test seam for process-local refresh coordination state. */
export function __resetMaxaiRefreshStateForTesting(): void {
  inFlightRefreshes.clear();
  refreshFailures.clear();
}

/** Test seam for asserting bounded coordinator state. */
export function __getMaxaiRefreshFailureCountForTesting(): number {
  return refreshFailures.size;
}

/** True when an access token is missing, unparseable, or within the margin of expiry. */
export function maxaiAccessTokenNeedsRefresh(
  accessToken: string | null | undefined,
  marginSeconds: number = MAXAI_REFRESH_MARGIN_SECONDS,
  now: () => number = Date.now
): boolean {
  if (!accessToken) return true;
  const exp = accessTokenExpiry(accessToken);
  if (!exp) return true;
  const remainingSeconds = exp - now() / 1000;
  return remainingSeconds <= marginSeconds;
}

/**
 * Mint a fresh access token from a refresh token via one signed HTTP POST.
 * Never throws; returns a structured result the caller can branch on.
 */
export async function maxaiRefreshAccessToken(
  input: MaxaiRefreshInput
): Promise<MaxaiRefreshResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const userId = input.userId || userIdFromJwt(input.refreshToken) || "";
  if (!input.refreshToken || !input.deviceId || !userId) {
    return { ok: false, status: 0, error: "missing refreshToken, deviceId, or userId" };
  }

  // Daily refresh is our freshness checkpoint for the signing constants: re-extract
  // from MaxAI's public bundle so a MaxAI-side key/app-version rotation is picked up
  // within a day (self-heal). refreshMaxaiConstants persists a changed set and
  // returns the current-best; on a fetch miss it returns whatever's already stored.
  const constants = await refreshMaxaiConstants({ fetchImpl: doFetch, signal: input.signal });
  if (!constants) {
    return {
      ok: false,
      status: 0,
      error: "MaxAI signing constants unavailable (extraction failed)",
    };
  }

  const signed = buildMaxaiSignedHeaders(
    {
      path: MAXAI_REFRESH_PATH,
      userId,
      deviceId: input.deviceId,
    },
    constants
  );
  const headers: Record<string, string> = {
    ...maxaiStaticHeaders(),
    ...signed,
    Authorization: `Bearer ${input.refreshToken}`,
    noAuthLogout: "true",
    "Content-Type": "application/json",
  };

  let res: Response;
  try {
    res = await doFetch(MAXAI_BASE_URL + MAXAI_REFRESH_PATH, {
      method: "POST",
      headers,
      body: JSON.stringify({ app: "maxai_webapp" }),
      signal: input.signal ?? undefined,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const raw = await res.text().catch(() => "");
  if (res.status !== 200) {
    return { ok: false, status: res.status, error: raw.slice(0, 200) };
  }

  let accessToken = "";
  let refreshToken = "";
  try {
    const parsed = JSON.parse(raw) as {
      data?: {
        access_token?: unknown;
        accessToken?: unknown;
        refresh_token?: unknown;
        refreshToken?: unknown;
      };
      access_token?: unknown;
      accessToken?: unknown;
      refresh_token?: unknown;
      refreshToken?: unknown;
    };
    const candidate =
      parsed?.data?.access_token ??
      parsed?.data?.accessToken ??
      parsed?.access_token ??
      parsed?.accessToken;
    if (typeof candidate === "string") accessToken = candidate;
    const refreshCandidate =
      parsed?.data?.refresh_token ??
      parsed?.data?.refreshToken ??
      parsed?.refresh_token ??
      parsed?.refreshToken;
    if (typeof refreshCandidate === "string") refreshToken = refreshCandidate;
  } catch {
    return { ok: false, status: res.status, error: "unparseable refresh response" };
  }
  if (!accessToken) {
    return { ok: false, status: res.status, error: "refresh response had no access_token" };
  }

  return {
    ok: true,
    status: 200,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: accessTokenExpiry(accessToken) || undefined,
  };
}

/**
 * Share one refresh per connection and briefly cache failures so a rejected
 * client profile cannot make every concurrent or subsequent request retry.
 */
export async function maxaiRefreshAccessTokenOnce(
  scope: string | null | undefined,
  input: MaxaiRefreshInput,
  options: {
    run?: typeof maxaiRefreshAccessToken;
    now?: () => number;
    failureCooldownMs?: number;
    timeoutMs?: number;
  } = {}
): Promise<MaxaiRefreshResult> {
  const scopeKey = scope?.trim();
  const run = options.run ?? maxaiRefreshAccessToken;
  if (!scopeKey) {
    if (input.signal?.aborted) return callerAbortResult();
    return run(input);
  }

  const now = options.now ?? Date.now;
  pruneRefreshFailures(now());
  if (input.signal?.aborted) return callerAbortResult();

  // A connection can rotate its refresh token. Keep each token generation in a
  // separate lane without retaining the secret itself in process-local map keys.
  const key = refreshGenerationKey(scopeKey, input.refreshToken);

  const failed = refreshFailures.get(key);
  if (failed) return failed.result;

  const existing = inFlightRefreshes.get(key);
  if (existing) return waitForRefresh(existing, input.signal);

  // The shared operation owns a bounded signal. A caller's signal only controls
  // how long that caller waits and can never cancel or poison the shared refresh.
  const controller = new AbortController();
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs >= 0
      ? options.timeoutMs
      : MAXAI_REFRESH_TIMEOUT_MS;
  const sharedInput = { ...input, signal: controller.signal };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let started!: Promise<MaxaiRefreshResult>;
  const runPromise = Promise.resolve().then(() => run(sharedInput));
  const timeoutResult = refreshTimeoutResult();
  const timeoutPromise = new Promise<MaxaiRefreshResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(timeoutResult);
    }, timeoutMs);
  });
  started = Promise.race([runPromise, timeoutPromise])
    .then((result) => {
      if (result.ok) {
        refreshFailures.delete(key);
      } else if (result !== timeoutResult) {
        const cooldownMs =
          typeof options.failureCooldownMs === "number" &&
          Number.isFinite(options.failureCooldownMs) &&
          options.failureCooldownMs >= 0
            ? options.failureCooldownMs
            : MAXAI_REFRESH_FAILURE_COOLDOWN_MS;
        refreshFailures.set(key, { until: now() + cooldownMs, result });
        enforceRefreshFailureLimit();
      }
      return result;
    })
    .finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (inFlightRefreshes.get(key) === started) inFlightRefreshes.delete(key);
    });
  inFlightRefreshes.set(key, started);
  return waitForRefresh(started, input.signal);
}

export interface EnsureFreshMaxaiCredentialInput {
  credential: MaxaiCredential;
  connectionId?: string | null;
  providerSpecificData?: Record<string, unknown> | null;
  signal?: AbortSignal | null;
  fetchImpl?: typeof fetch;
  onCredentialsRefreshed?: (credentials: {
    accessToken: string;
    refreshToken?: string;
    providerSpecificData: Record<string, unknown>;
  }) => void | Promise<void>;
  onPersistError?: (error: unknown) => void;
}

/** Refresh near expiry, use the minted token now, and persist any token rotation. */
export async function ensureFreshMaxaiCredential(
  input: EnsureFreshMaxaiCredentialInput
): Promise<MaxaiCredential> {
  const cred = input.credential;
  if (!cred.refreshToken || !maxaiAccessTokenNeedsRefresh(cred.accessToken)) return cred;

  const result = await maxaiRefreshAccessTokenOnce(input.connectionId, {
    refreshToken: cred.refreshToken,
    deviceId: cred.deviceId,
    userId: cred.userId,
    signal: input.signal,
    fetchImpl: input.fetchImpl,
  });
  if (!result.ok || !result.accessToken) return cred;

  const refreshToken = result.refreshToken ?? cred.refreshToken;
  const updated: MaxaiCredential = { ...cred, accessToken: result.accessToken, refreshToken };
  try {
    await input.onCredentialsRefreshed?.({
      accessToken: result.accessToken,
      refreshToken,
      providerSpecificData: {
        ...(input.providerSpecificData ?? {}),
        maxaiAccessToken: result.accessToken,
        maxaiRefreshToken: refreshToken,
      },
    });
  } catch (error) {
    input.onPersistError?.(error);
  }
  return updated;
}
