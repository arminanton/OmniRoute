/**
 * One signed MaxAI token exchange and its connection/generation coordinator.
 * Process singleflight is only an optimization. A durable CAS lease is required
 * before the rotating refresh token can leave this process.
 */
import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { isProbeContext } from "@/shared/utils/probeOrigin";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { maxaiFetch, withMaxaiTransportOwner } from "../../services/maxaiTransport.ts";
import { buildMaxaiSignedHeaders } from "./signing.ts";
import { maxaiStaticHeaders, MAXAI_BASE_URL } from "./protocol.ts";
import { userIdFromJwt, accessTokenExpiry, type MaxaiCredential } from "./credentials.ts";
import { refreshMaxaiConstants } from "./constantsStore.ts";

export const MAXAI_REFRESH_PATH = "/oauth/refresh_access_token";
export const MAXAI_REFRESH_MARGIN_SECONDS = 60 * 60;
export const MAXAI_REFRESH_TIMEOUT_MS = 30_000;
export const MAXAI_REFRESH_FAILURE_COOLDOWN_MS = 5 * 60_000;
export const MAXAI_REFRESH_MAX_ENTRIES = 256;

/** Only these fixed strings may escape the refresh boundary. Never attach a cause. */
export const MAXAI_REFRESH_ERRORS = {
  connection: "MaxAI connection ID is required.",
  invalid: "MaxAI refresh credentials are invalid.",
  expired: "MaxAI access token is expired or invalid.",
  constants: "MaxAI signing constants are unavailable.",
  failed: "MaxAI token refresh failed.",
  response: "MaxAI refresh response is invalid.",
  redirect: "MaxAI refresh redirect rejected.",
  aborted: "MaxAI request was cancelled.",
  timeout: "MaxAI token refresh timed out.",
  storage: "MaxAI credential storage is unavailable.",
  conflict: "MaxAI credential update was rejected.",
  persistence: "MaxAI credential persistence failed.",
  busy: "MaxAI token refresh is already in progress.",
  quarantined: "MaxAI token refresh requires sign-in.",
  cooldown: "MaxAI token refresh is cooling down.",
  capacity: "MaxAI token refresh capacity is exhausted.",
} as const;

export type MaxaiRefreshErrorCode = keyof typeof MAXAI_REFRESH_ERRORS;
const ERROR_STATUS: Record<MaxaiRefreshErrorCode, number> = {
  connection: 400,
  invalid: 401,
  expired: 401,
  constants: 503,
  failed: 502,
  response: 502,
  redirect: 502,
  aborted: 499,
  timeout: 504,
  storage: 503,
  conflict: 409,
  persistence: 503,
  busy: 503,
  quarantined: 401,
  cooldown: 503,
  capacity: 503,
};

export class MaxaiRefreshError extends Error {
  readonly code: MaxaiRefreshErrorCode;
  readonly status: number;

  constructor(code: MaxaiRefreshErrorCode, accountStatus?: 401 | 403 | 429) {
    super(MAXAI_REFRESH_ERRORS[code]);
    this.name = "MaxaiRefreshError";
    this.code = code;
    this.status = accountStatus ?? ERROR_STATUS[code];
  }
}

type MaybePromise<T> = T | Promise<T>;

export interface MaxaiRefreshLease {
  connectionId: string;
  /** Full SHA-256 hex digest, never the plaintext refresh token. */
  generation: string;
  owner: string;
}

export interface MaxaiRefreshAcquireInput extends MaxaiRefreshLease {
  leaseExpiresAt: number;
  /** Opaque encrypted-snapshot version from the last authoritative store read. */
  expectedCredentialVersion: string;
}

export interface MaxaiRefreshCommitInput extends MaxaiRefreshLease {
  credential: MaxaiCredential;
}

export interface MaxaiStoredCredential extends MaxaiCredential {
  /** Changes on every durable token commit, even with identical plaintext. */
  credentialVersion: string;
}

/**
 * Durable storage contract. Implementations must atomically bind the current
 * encrypted credential snapshot on acquire, and require the same snapshot and
 * live owner on markSent/commit. An unresolved SENT generation is quarantined
 * after lease expiry/crash, never automatically posted again. release may only
 * delete an UNSENT lease owned by this caller. A successful commit merges the
 * latest unrelated PSD and writes encrypted canonical access/refresh tokens.
 */
export interface MaxaiRefreshStore {
  read(connectionId: string): MaybePromise<MaxaiStoredCredential | null>;
  acquire(
    input: MaxaiRefreshAcquireInput
  ): MaybePromise<"acquired" | "busy" | "stale" | "quarantined" | "missing">;
  markSent(input: MaxaiRefreshLease): MaybePromise<boolean>;
  commit(input: MaxaiRefreshCommitInput): MaybePromise<boolean>;
  release(input: MaxaiRefreshLease): MaybePromise<void>;
}

export interface MaxaiRefreshInput {
  refreshToken: string;
  deviceId: string;
  userId?: string;
  signal?: AbortSignal | null;
  /** Tests may inject HTTP; production requires the selected MaxAI TLS scope. */
  fetchImpl?: typeof fetch;
  /** Coordinator's durable sent marker. false means NO dispatch is permitted. */
  beforeSend?: () => MaybePromise<boolean>;
}

export interface MaxaiRefreshResult {
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  status: number;
  error?: string;
  code?: MaxaiRefreshErrorCode;
}

export interface EnsureFreshMaxaiCredentialInput {
  connectionId: string;
  credential: MaxaiCredential;
  signal?: AbortSignal | null;
  fetchImpl?: typeof fetch;
  /** Production defaults to the DB domain store, never a memory-only store. */
  store?: MaxaiRefreshStore;
  /** Optional additional acknowledgement; NEVER a replacement for the CAS store. */
  onCredentialsRefreshed?: (credential: MaxaiCredential) => MaybePromise<boolean | void>;
}

const safeString = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => value.trim() === value && !/[\r\n]/.test(value) && !value.includes("\0"));
const credentialSchema = z.object({
  accessToken: safeString,
  refreshToken: safeString.optional(),
  deviceId: safeString,
  userId: safeString,
});
const storedCredentialSchema = credentialSchema.extend({
  credentialVersion: z.string().min(1).max(256),
});
const responseTokensSchema = z.object({
  access_token: safeString.optional(),
  accessToken: safeString.optional(),
  refresh_token: safeString.optional(),
  refreshToken: safeString.optional(),
});
const refreshResponseSchema = responseTokensSchema.extend({
  data: responseTokensSchema.optional(),
});

export function maxaiRefreshGeneration(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

/** Missing, malformed and non-finite expiry claims are never treated as fresh. */
export function maxaiAccessTokenNeedsRefresh(
  accessToken: string | null | undefined,
  marginSeconds: number = MAXAI_REFRESH_MARGIN_SECONDS,
  now: () => number = Date.now
): boolean {
  if (!accessToken) return true;
  const expiry = accessTokenExpiry(accessToken);
  return !expiry || expiry - now() / 1000 <= marginSeconds;
}

interface Deadline {
  signal: AbortSignal;
  expiresAt: number;
  assertActive(): void;
}

/** Race the work, not only fetch's abort signal: injected/native I/O may ignore it. */
async function bounded<T>(
  run: (deadline: Deadline) => Promise<T>,
  callerSignal?: AbortSignal | null
): Promise<T> {
  const controller = new AbortController();
  const expiresAt = Date.now() + MAXAI_REFRESH_TIMEOUT_MS;
  let active = true;
  const abort = () => controller.abort(new MaxaiRefreshError("aborted"));
  const timeout = setTimeout(
    () => controller.abort(new MaxaiRefreshError("timeout")),
    MAXAI_REFRESH_TIMEOUT_MS
  );
  let rejectAbort!: (error: MaxaiRefreshError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(controller.signal.reason as MaxaiRefreshError);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (callerSignal?.aborted) abort();
  const deadline: Deadline = {
    signal: controller.signal,
    expiresAt,
    assertActive() {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!active || Date.now() >= expiresAt) throw new MaxaiRefreshError("timeout");
    },
  };
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        deadline.assertActive();
        return run(deadline);
      }),
      aborted,
    ]);
  } finally {
    active = false;
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function failure(code: MaxaiRefreshErrorCode, status = 0): MaxaiRefreshResult {
  return { ok: false, status, code, error: MAXAI_REFRESH_ERRORS[code] };
}

function cancelBody(response: Response | undefined): void {
  try {
    void response?.body?.cancel().catch(() => {});
  } catch {
    // A locked/stuck body must not delay a terminal failure or leak its content.
  }
}

/** One signed POST. All failure messages are fixed; no upstream content is returned. */
export async function maxaiRefreshAccessToken(
  input: MaxaiRefreshInput
): Promise<MaxaiRefreshResult> {
  const userId = input.userId || userIdFromJwt(input.refreshToken) || "";
  if (
    !safeString.safeParse(input.refreshToken).success ||
    !safeString.safeParse(input.deviceId).success ||
    !safeString.safeParse(userId).success
  ) {
    return failure("invalid");
  }
  const doFetch = input.fetchImpl ?? maxaiFetch;
  let response: Response | undefined;
  try {
    return await bounded(async (deadline) => {
      // The public bundle and signed refresh always use the same selected fetch.
      const constants = await refreshMaxaiConstants({
        fetchImpl: doFetch,
        signal: deadline.signal,
      });
      deadline.assertActive();
      if (!constants) return failure("constants");
      const headers: Record<string, string> = {
        ...maxaiStaticHeaders(),
        ...buildMaxaiSignedHeaders(
          { path: MAXAI_REFRESH_PATH, userId, deviceId: input.deviceId },
          constants
        ),
        Authorization: `Bearer ${input.refreshToken}`,
        noAuthLogout: "true",
        "Content-Type": "application/json",
      };
      if (input.beforeSend && (await input.beforeSend()) !== true) return failure("conflict");
      deadline.assertActive();
      const url = MAXAI_BASE_URL + MAXAI_REFRESH_PATH;
      response = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ app: "maxai_webapp" }),
        redirect: "error",
        signal: deadline.signal,
      });
      try {
        deadline.assertActive();
      } catch (error) {
        // A transport that ignored abort may hand us a live body after the race
        // already settled. Dispose it without permitting any late work.
        cancelBody(response);
        throw error;
      }
      if (
        (response.status >= 300 && response.status < 400) ||
        response.redirected ||
        response.type === "opaqueredirect" ||
        (response.url && response.url !== url)
      ) {
        cancelBody(response);
        return failure("redirect", response.status);
      }
      if (response.status !== 200) {
        cancelBody(response);
        return failure("failed", response.status);
      }
      const raw = await response.text();
      deadline.assertActive();
      let parsed: z.infer<typeof refreshResponseSchema>;
      try {
        parsed = refreshResponseSchema.parse(JSON.parse(raw));
      } catch {
        return failure("response", 200);
      }
      const accessToken =
        parsed.data?.access_token ??
        parsed.data?.accessToken ??
        parsed.access_token ??
        parsed.accessToken;
      const refreshToken =
        parsed.data?.refresh_token ??
        parsed.data?.refreshToken ??
        parsed.refresh_token ??
        parsed.refreshToken;
      if (!accessToken || maxaiAccessTokenNeedsRefresh(accessToken, 0))
        return failure("response", 200);
      return {
        ok: true,
        status: 200,
        accessToken,
        refreshToken,
        expiresAt: accessTokenExpiry(accessToken),
      };
    }, input.signal);
  } catch (error) {
    cancelBody(response);
    if (isRuntimePolicyError(error)) throw error;
    return failure(error instanceof MaxaiRefreshError ? error.code : "failed");
  }
}

interface RefreshEntry {
  promise: Promise<MaxaiCredential> | null;
  retryAt: number;
  waiters: number;
  accountStatus?: 401 | 403 | 429;
}

const refreshState = new Map<string, RefreshEntry>();
let ownRefreshTransport = withMaxaiTransportOwner;

/** Module-only test seam; never accepted as a request or credential option. */
export function __setMaxaiRefreshOwnerForTest(owner: typeof withMaxaiTransportOwner | null): void {
  ownRefreshTransport = owner ?? withMaxaiTransportOwner;
}

/** Test seams expose only counts, never plaintext credentials or connection keys. */
export function __maxaiRefreshStateSizeForTest(): number {
  return refreshState.size;
}
export function __resetMaxaiRefreshStateForTest(): void {
  refreshState.clear();
}

async function storageCall<T>(run: () => MaybePromise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    throw new MaxaiRefreshError("storage");
  }
}

function validCredential(value: unknown): value is MaxaiCredential {
  return credentialSchema.safeParse(value).success;
}

function validStoredCredential(value: unknown): value is MaxaiStoredCredential {
  return storedCredentialSchema.safeParse(value).success;
}

/** Keep store metadata out of HTTP, optional callbacks and executor captures. */
function plainCredential(value: MaxaiCredential): MaxaiCredential {
  return credentialSchema.parse(value);
}

async function refreshStoredCredential(
  input: EnsureFreshMaxaiCredentialInput,
  generation: string,
  entry: RefreshEntry
): Promise<MaxaiCredential> {
  // Own the shared operation through commit/readback, not any caller's wait.
  // Retain only its bounded lifetime: ignored I/O must not renew forever after
  // timeout. Late continuations still face deadline checks and the store CAS.
  return ownRefreshTransport(() =>
    bounded(async (deadline) => {
      const canStart = () => {
        deadline.assertActive();
        if (!entry.waiters) throw new MaxaiRefreshError("aborted");
      };
      canStart();
      const store =
        input.store ??
        (await storageCall(
          async () => (await import("@/lib/db/maxaiCredentials")).maxaiRefreshStore
        ));
      deadline.assertActive();
      const current = await storageCall(() => store.read(input.connectionId));
      canStart();
      if (!validStoredCredential(current)) throw new MaxaiRefreshError("invalid");
      if (!maxaiAccessTokenNeedsRefresh(current.accessToken)) return plainCredential(current);
      if (!current.refreshToken) throw new MaxaiRefreshError("expired");
      if (maxaiRefreshGeneration(current.refreshToken) !== generation) {
        throw new MaxaiRefreshError("conflict");
      }
      const lease: MaxaiRefreshAcquireInput = {
        connectionId: input.connectionId,
        generation,
        owner: randomUUID(),
        leaseExpiresAt: deadline.expiresAt,
        expectedCredentialVersion: current.credentialVersion,
      };
      let owned = false;
      try {
        const state = await storageCall(() => store.acquire(lease));
        owned = state === "acquired";
        canStart();
        if (!owned) {
          if (state === "quarantined") throw new MaxaiRefreshError("quarantined");
          // Another worker may have committed since our read. Only its fresh
          // authoritative row can be used; no stale-token fallthrough is allowed.
          const winner = await storageCall(() => store.read(input.connectionId));
          canStart();
          if (validStoredCredential(winner) && !maxaiAccessTokenNeedsRefresh(winner.accessToken))
            return plainCredential(winner);
          throw new MaxaiRefreshError(state === "busy" ? "busy" : "conflict");
        }
        const result = await maxaiRefreshAccessToken({
          refreshToken: current.refreshToken,
          deviceId: current.deviceId,
          userId: current.userId,
          fetchImpl: input.fetchImpl,
          signal: deadline.signal,
          beforeSend: async () => {
            canStart();
            const marked = await storageCall(() => store.markSent(lease));
            deadline.assertActive();
            return marked;
          },
        });
        deadline.assertActive();
        if (!result.ok || !result.accessToken) {
          const accountStatus =
            result.status === 418
              ? 401
              : result.status === 401 || result.status === 403 || result.status === 429
                ? result.status
                : undefined;
          throw new MaxaiRefreshError(result.code ?? "failed", accountStatus);
        }
        const next: MaxaiCredential = {
          ...plainCredential(current),
          accessToken: result.accessToken,
          refreshToken: result.refreshToken ?? current.refreshToken,
        };
        // The store checks both lease expiry and the original encrypted snapshot.
        // No generic callback may replace this generation-conditional commit.
        if ((await storageCall(() => store.commit({ ...lease, credential: next }))) !== true) {
          throw new MaxaiRefreshError("conflict");
        }
        deadline.assertActive();
        if (input.onCredentialsRefreshed) {
          try {
            if ((await input.onCredentialsRefreshed(next)) === false)
              throw new MaxaiRefreshError("persistence");
          } catch (error) {
            if (isRuntimePolicyError(error)) throw error;
            throw new MaxaiRefreshError("persistence");
          }
          deadline.assertActive();
        }
        const committed = await storageCall(() => store.read(input.connectionId));
        deadline.assertActive();
        if (
          !validStoredCredential(committed) ||
          maxaiAccessTokenNeedsRefresh(committed.accessToken, 0)
        ) {
          throw new MaxaiRefreshError("conflict");
        }
        return plainCredential(committed);
      } finally {
        if (owned) {
          // This must never release/quash a sent generation. DB expiry/quarantine
          // remains the backstop if cleanup is interrupted or storage is down.
          void Promise.resolve()
            .then(() => store.release(lease))
            .catch(() => {});
        }
      }
    })
  );
}

/** An individual request may stop waiting without aborting the shared rotation. */
function waitForCaller(entry: RefreshEntry, signal?: AbortSignal | null): Promise<MaxaiCredential> {
  return new Promise((resolve, reject) => {
    entry.waiters++;
    let finished = false;
    const finish = (error?: unknown, value?: MaxaiCredential) => {
      if (finished) return;
      finished = true;
      entry.waiters--;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(new MaxaiRefreshError("aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    entry.promise!.then(
      (value) => (signal?.aborted ? abort() : finish(undefined, value)),
      (error: unknown) => finish(error)
    );
  });
}

/**
 * Shared by chat, images and discovery. Requires a connection ID, independent
 * caller cancellation, a bounded operation and a durable lease/CAS before use.
 * No failure falls through with an expired/invalid or aborted credential.
 */
export async function ensureFreshMaxaiCredential(
  input: EnsureFreshMaxaiCredentialInput
): Promise<MaxaiCredential> {
  if (typeof input.connectionId !== "string" || !input.connectionId.trim()) {
    throw new MaxaiRefreshError("connection");
  }
  if (input.signal?.aborted) throw new MaxaiRefreshError("aborted");
  if (!validCredential(input.credential)) throw new MaxaiRefreshError("invalid");
  // A marked probe may use a still-live bearer, but must not spend or join a
  // rotating grant. Keep expired/malformed credentials fail-closed.
  if (isProbeContext()) {
    if (maxaiAccessTokenNeedsRefresh(input.credential.accessToken, 0))
      throw new MaxaiRefreshError("expired");
    return input.credential;
  }
  if (!maxaiAccessTokenNeedsRefresh(input.credential.accessToken)) return input.credential;
  if (!input.credential.refreshToken) {
    if (maxaiAccessTokenNeedsRefresh(input.credential.accessToken, 0))
      throw new MaxaiRefreshError("expired");
    return input.credential;
  }
  const generation = maxaiRefreshGeneration(input.credential.refreshToken);
  const key = JSON.stringify([input.connectionId, generation]);
  const now = Date.now();
  for (const [oldKey, old] of refreshState) {
    if (!old.promise && old.retryAt <= now) refreshState.delete(oldKey);
  }
  let entry = refreshState.get(key);
  if (entry && !entry.promise) throw new MaxaiRefreshError("cooldown", entry.accountStatus);
  if (!entry) {
    if (refreshState.size >= MAXAI_REFRESH_MAX_ENTRIES) throw new MaxaiRefreshError("capacity");
    entry = { promise: null, retryAt: 0, waiters: 0 };
    refreshState.set(key, entry);
    const ownedEntry = entry;
    entry.promise = refreshStoredCredential(input, generation, entry).then(
      (value) => {
        if (refreshState.get(key) === ownedEntry) refreshState.delete(key);
        return value;
      },
      (error: unknown) => {
        if (isRuntimePolicyError(error)) {
          // This is not provider health/cooldown. Drop only the in-memory waiter
          // entry; the durable SENT/uncertain generation remains quarantined.
          if (refreshState.get(key) === ownedEntry) refreshState.delete(key);
          throw error;
        }
        const safeError =
          error instanceof MaxaiRefreshError ? error : new MaxaiRefreshError("failed");
        if (refreshState.get(key) === ownedEntry) {
          if (safeError.code === "aborted") refreshState.delete(key);
          else {
            ownedEntry.promise = null;
            ownedEntry.retryAt = Date.now() + MAXAI_REFRESH_FAILURE_COOLDOWN_MS;
            if (safeError.status === 401 || safeError.status === 403 || safeError.status === 429) {
              ownedEntry.accountStatus = safeError.status;
            }
          }
        }
        throw safeError;
      }
    );
  }
  return waitForCaller(entry, input.signal);
}
