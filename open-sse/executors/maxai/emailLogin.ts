/**
 * MaxAI email login — browserless, two signed HTTP calls (a codex-style
 * device-pair flow, no browser / camoufox / Google navigation).
 *
 * MaxAI's web app offers email-code sign-in as an alternative to Google OAuth.
 * Both steps are plain signed POSTs carrying the same per-request X-Authorization
 * signature as every other MaxAI call (see ./signing.ts); both paths are in the
 * signer's BLANK_USER_ROUTES (they sign with a blank user_id, correct — there is
 * no user id yet before login). Ported byte-faithfully from the MaxAI web-app
 * bundle (chunk 86042: signInWithEmail line ~5623, verifySecretCode line ~5665).
 *
 * Step 1 — request a code (POST /oauth/signin_with_email):
 *     body { email, app: "maxai_webapp" }  ->  { status: "OK" }  (code emailed)
 *
 * Step 2 — verify the code (POST /oauth/verify_secret_code):
 *     body { email, secret_code, app: "maxai_webapp", env: "prod_co",
 *            client_user_id, ...nullable attribution fields }
 *     ->  { auth_user: { accessToken, refreshToken, userId, email, clientUserId } }
 *
 * The `device_id` folded into the signature is a CLIENT-GENERATED UUID (the web
 * app's getAPIFetchDeviceID = "return stored, else generate + persist"), so the
 * caller mints one with randomUUID() and reuses it across BOTH steps and for all
 * subsequent chat / refresh calls (the minted token is bound to that device id).
 * `client_user_id` is likewise a client UUID.
 */
import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { z } from "zod";
import { maxaiFetch } from "../../services/maxaiTransport.ts";
import { sanitizeErrorMessage } from "../../utils/error.ts";
import { buildMaxaiSignedHeaders } from "./signing.ts";
import { maxaiStaticHeaders, MAXAI_BASE_URL } from "./protocol.ts";
import { ensureMaxaiConstants } from "./constantsStore.ts";
import type { MaxaiSigningConstants } from "./constants.ts";

export const MAXAI_SIGNIN_EMAIL_PATH = "/oauth/signin_with_email";
export const MAXAI_VERIFY_CODE_PATH = "/oauth/verify_secret_code";

/** The web app's env tag for production email verification. */
const MAXAI_VERIFY_ENV = "prod_co";

export const MAXAI_LOGIN_ERROR = sanitizeErrorMessage("MaxAI sign-in failed. Please try again.");
export const MAXAI_LOGIN_TIMEOUT_MS = 30_000;
const MAXAI_LOGIN_RESPONSE_BYTES = 64 * 1024;
const emailSchema = z.string().max(254).trim().email();
const codeSchema = z
  .string()
  .length(6)
  .regex(/^[0-9]{6}$/);
const identityIdSchema = z.string().length(36).uuid();

/** Shared with the route so validation happens before any identity write or wire call. */
export const maxaiLoginBodySchema = z
  .object({
    step: z.enum(["request", "verify"]).default("request"),
    email: emailSchema.optional(),
    code: codeSchema.optional(),
  })
  .strict()
  .refine((body) => (body.step === "request" ? !!body.email : !!body.code));

export const maxaiLoginIdentitySchema = z.object({
  email: emailSchema,
  deviceId: identityIdSchema,
  clientUserId: identityIdSchema,
});
const requestInputSchema = maxaiLoginIdentitySchema.omit({ clientUserId: true });
const verifyInputSchema = maxaiLoginIdentitySchema.extend({ code: codeSchema });
const tokenSchema = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[\x21-\x7e]{1,16384}$/);
const userIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]{1,128}$/);

export interface MaxaiEmailRequestInput {
  email: string;
  /** Client device UUID (mint once, reuse for verify + all later calls). */
  deviceId: string;
  signal?: AbortSignal | null;
  fetchImpl?: typeof fetch;
}

export interface MaxaiEmailVerifyInput {
  email: string;
  /** The 6-digit code the user received by email. */
  code: string;
  /** Same device UUID used in the request step. */
  deviceId: string;
  /** Client-user UUID (mint once alongside deviceId). */
  clientUserId: string;
  signal?: AbortSignal | null;
  fetchImpl?: typeof fetch;
}

export interface MaxaiEmailRequestResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** The full credential set returned by a successful verify. */
export interface MaxaiLoginCredential {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  deviceId: string;
  clientUserId: string;
}

export interface MaxaiEmailVerifyResult {
  ok: boolean;
  status: number;
  credential?: MaxaiLoginCredential;
  error?: string;
}

/** Build signed headers for a blank-user OAuth route (user id is blanked in the proof). */
function signedOauthHeaders(
  path: string,
  deviceId: string,
  constants: MaxaiSigningConstants
): Record<string, string> {
  return {
    ...maxaiStaticHeaders(),
    // userId is blanked inside computeMaxaiProof for BLANK_USER_ROUTES; pass "".
    ...buildMaxaiSignedHeaders({ path, userId: "", deviceId }, constants),
  };
}

/** Pull a nested-or-top-level field from a MaxAI response body ({data:{...}} | {...}). */
function pick<T = unknown>(body: Record<string, unknown>, key: string): T | undefined {
  const data = body?.data as Record<string, unknown> | undefined;
  const nested = data?.[key];
  if (nested !== undefined) return nested as T;
  return body?.[key] as T | undefined;
}

/** A single deadline covers constants extraction, the signed POST, and the response body. */
async function withLoginDeadline<T>(
  parent: AbortSignal | null | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(); // Never forward credential-bearing abort reasons.
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, MAXAI_LOGIN_TIMEOUT_MS);
  timeout.unref?.();
  let onAbort: () => void = () => {};
  try {
    controller.signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error(MAXAI_LOGIN_ERROR));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    // Also bound adapters that fail to settle promptly after receiving an abort.
    return await Promise.race([aborted, run(controller.signal)]);
  } finally {
    clearTimeout(timeout);
    parent?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

async function readLoginBody(res: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error(MAXAI_LOGIN_ERROR);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAXAI_LOGIN_RESPONSE_BYTES) {
        cancel();
        throw new Error(MAXAI_LOGIN_ERROR);
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(MAXAI_LOGIN_ERROR);
    }
    return body as Record<string, unknown>;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function postSignedLogin(
  input: MaxaiEmailRequestInput,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body?: Record<string, unknown> }> {
  const doFetch = input.fetchImpl ?? maxaiFetch;
  let status = 0;
  try {
    return await withLoginDeadline(input.signal, async (signal) => {
      signal.throwIfAborted();
      const constants = await ensureMaxaiConstants({ fetchImpl: doFetch, signal });
      signal.throwIfAborted();
      if (!constants) return { status };
      const res = await doFetch(MAXAI_BASE_URL + path, {
        method: "POST",
        headers: signedOauthHeaders(path, input.deviceId, constants),
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      status = res.status;
      if (signal.aborted || status !== 200) {
        void res.body?.cancel().catch(() => {});
        return { status };
      }
      return { status, body: await readLoginBody(res, signal) };
    });
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    return { status };
  }
}

/** Step 1: request a code with persisted identity. Policy denial remains terminal. */
export async function requestMaxaiEmailCode(
  input: MaxaiEmailRequestInput
): Promise<MaxaiEmailRequestResult> {
  const parsed = requestInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 0, error: MAXAI_LOGIN_ERROR };
  const result = await postSignedLogin({ ...input, ...parsed.data }, MAXAI_SIGNIN_EMAIL_PATH, {
    email: parsed.data.email,
    app: "maxai_webapp",
  });
  if (result.body && pick(result.body, "status") === "OK") {
    return { ok: true, status: 200 };
  }
  return { ok: false, status: result.status, error: MAXAI_LOGIN_ERROR };
}

/** Step 2: verify the pending identity. The caller must persist all credentials before success. */
export async function verifyMaxaiEmailCode(
  input: MaxaiEmailVerifyInput
): Promise<MaxaiEmailVerifyResult> {
  const parsed = verifyInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 0, error: MAXAI_LOGIN_ERROR };
  const identity = parsed.data;
  const result = await postSignedLogin({ ...input, ...identity }, MAXAI_VERIFY_CODE_PATH, {
    email: identity.email,
    secret_code: identity.code,
    app: "maxai_webapp",
    env: MAXAI_VERIFY_ENV,
    invitation_code: null,
    ref: "",
    client_reference_id: null,
    client_user_id: identity.clientUserId,
    client_price_version: null,
    client_onboarding_version: null,
    user_acquisition_channel: "",
    gclid: null,
  });
  const failure: MaxaiEmailVerifyResult = {
    ok: false,
    status: result.status,
    error: MAXAI_LOGIN_ERROR,
  };
  if (!result.body || pick(result.body, "status") !== "OK") return failure;
  const authUser = pick<Record<string, unknown>>(result.body, "auth_user");
  if (!authUser || typeof authUser !== "object" || Array.isArray(authUser)) return failure;
  const accessToken = tokenSchema.safeParse(authUser.accessToken ?? authUser.access_token);
  const refreshToken = tokenSchema.safeParse(authUser.refreshToken ?? authUser.refresh_token);
  const userId = userIdSchema.safeParse(authUser.userId ?? authUser.user_id);
  const email = emailSchema.safeParse(authUser.email ?? identity.email);
  const clientUserId = identityIdSchema.safeParse(
    authUser.clientUserId ?? authUser.client_user_id ?? identity.clientUserId
  );
  if (
    !accessToken.success ||
    !refreshToken.success ||
    !userId.success ||
    !email.success ||
    !clientUserId.success ||
    email.data.toLowerCase() !== identity.email.toLowerCase() ||
    clientUserId.data !== identity.clientUserId
  )
    return failure;
  return {
    ok: true,
    status: 200,
    credential: {
      accessToken: accessToken.data,
      refreshToken: refreshToken.data,
      userId: userId.data,
      email: identity.email,
      deviceId: identity.deviceId,
      clientUserId: identity.clientUserId,
    },
  };
}
