/**
 * POST /api/providers/[id]/login
 *
 * Web-cookie provider login endpoint. Launches a browser,
 * navigates to the provider's login page, polls for session tokens,
 * and persists extracted credentials to the provider connection.
 */

import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { NextRequest, NextResponse } from "next/server";
import { getCachedProviderConnectionById } from "@/lib/db/readCache";
import { updateProviderConnection } from "@/lib/db/providers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { clampLoginTimeoutMs } from "@/lib/api/loginTimeout";
import {
  runtimePolicyErrorResponse,
  sanitizeErrorMessage,
} from "@omniroute/open-sse/utils/error.ts";

const ADOBE_FIREFLY_SLUGS = new Set(["adobe-firefly", "firefly"]);

/** Resolve the provider slug (e.g. "claude-web", "adobe-firefly") from the connection row. */
function resolveProviderSlug(connection: Record<string, unknown> | null): string {
  const raw = connection?.provider;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "";
}

function isAdobeFireflyProvider(
  connection: { provider?: unknown } | null,
  providerSlug: string
): boolean {
  const raw = String(connection?.provider || "").trim();
  return ADOBE_FIREFLY_SLUGS.has(raw) || ADOBE_FIREFLY_SLUGS.has(providerSlug);
}

/**
 * Persist JWT + Cookie the way desktop clients (and generate) expect:
 * multi-line api_key, plus camelCase providerSpecificData for updateProviderConnection.
 */
async function persistAdobeFireflyCredentials(
  connectionId: string,
  opts: {
    accessToken?: string;
    cookie?: string;
    account?: string;
    arpSessionId?: string;
  }
): Promise<{
  accessToken: string;
  cookie: string;
  credential: string;
  account: string;
}> {
  const accessToken = String(opts.accessToken || "").trim();
  const cookie = String(opts.cookie || "").trim();
  const account = String(opts.account || "").trim();
  const credential =
    accessToken && cookie
      ? `${accessToken}\n${cookie}`
      : accessToken ||
        cookie ||
        JSON.stringify({
          mode: "browser-profile",
          account,
          signedInAt: Date.now(),
        });

  const marker = {
    mode: "browser-profile",
    account,
    signedInAt: Date.now(),
    arpSessionId: String(opts.arpSessionId || ""),
  };

  try {
    // camelCase only — updateProviderConnection / encryptConnectionFields read apiKey +
    // providerSpecificData (snake_case keys are silently ignored and never persisted).
    await updateProviderConnection(connectionId, {
      apiKey: credential,
      providerSpecificData: {
        ...marker,
        cookie: cookie || credential,
        access_token: accessToken || undefined,
      },
    });
  } catch {
    /* non-fatal — return credentials to the host app either way */
  }

  return { accessToken, cookie, credential, account };
}

function adobeFireflySuccessResponse(data: {
  accessToken: string;
  cookie: string;
  credential: string;
  account: string;
  arpSessionId?: string;
  via: "pure-cdp";
}): NextResponse {
  return NextResponse.json({
    success: true,
    account: data.account || undefined,
    accessToken: data.accessToken || undefined,
    cookie: data.cookie || undefined,
    arpSessionId: data.arpSessionId || undefined,
    credential: data.credential,
    credentials: {
      access_token: data.accessToken || undefined,
      cookie: data.cookie || undefined,
    },
    via: data.via,
    persisted: true,
  });
}

/**
 * Adobe Firefly browser sign-in:
 * pure system Chrome/Edge CDP only (packaged-safe, no Playwright/browser bundle).
 */
async function loginAdobeFirefly(
  connectionId: string,
  body: { timeout?: unknown; freshSession?: unknown }
): Promise<NextResponse> {
  const timeout = typeof body.timeout === "number" ? body.timeout : undefined;
  const freshSession = typeof body.freshSession === "boolean" ? body.freshSession : true;

  // Pure system-browser CDP is the packaged-safe implementation. Do not open a second browser
  // after failure: it creates ambiguous success/error races and the packaged runtime has no
  // reliable Playwright browser bundle.
  // startAdobeFireflyBrowserLogin always kills its Chrome tree in `finally` (no orphans).
  try {
    const { startAdobeFireflyBrowserLogin } =
      await import("@omniroute/open-sse/services/adobeFireflyBrowserLogin.ts");
    const pure = await startAdobeFireflyBrowserLogin(timeout, {
      sessionKey: connectionId,
      freshSession,
    });
    if (pure.success && pure.credentials?.accessToken) {
      const persisted = await persistAdobeFireflyCredentials(connectionId, {
        accessToken: pure.credentials.accessToken,
        cookie: pure.credentials.cookie,
        account: pure.account,
      });
      return adobeFireflySuccessResponse({
        ...persisted,
        via: "pure-cdp",
      });
    }
    return NextResponse.json(
      {
        success: false,
        error: pure.error || "Adobe Firefly sign-in did not capture an authenticated IMS JWT.",
      },
      { status: 400 }
    );
  } catch (err) {
    const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}

// --- MaxAI: browserless email device-pair login -----------------------------

function maxaiLoginFailure(status: number): NextResponse {
  // Upstream bodies, transport errors, and persistence exceptions can contain credentials.
  return NextResponse.json(
    { success: false, error: sanitizeErrorMessage("MaxAI sign-in failed. Please try again.") },
    { status }
  );
}

function maxaiIdentityData(psd: Record<string, unknown>): Record<string, unknown> {
  const identity = { ...psd };
  // Generic providerSpecificData is not encrypted. Legacy token aliases are read-only.
  for (const key of ["maxaiAccessToken", "maxaiRefreshToken", "accessToken", "refreshToken"]) {
    delete identity[key];
  }
  return identity;
}

/** Persist the login identity before sending a code; verify only that pending identity. */
async function loginMaxaiEmail(
  connectionId: string,
  body: unknown,
  signal: AbortSignal
): Promise<NextResponse> {
  const { randomUUID } = await import("node:crypto");
  const {
    requestMaxaiEmailCode,
    verifyMaxaiEmailCode,
    maxaiLoginBodySchema,
    maxaiLoginIdentitySchema,
  } = await import("@omniroute/open-sse/executors/maxai/emailLogin.ts");

  const parsed = maxaiLoginBodySchema.safeParse(body);
  if (!parsed.success || signal.aborted) return maxaiLoginFailure(400);
  const data = parsed.data;
  const { getProviderConnectionById } = await import("@/lib/db/providers");
  const connection = await getProviderConnectionById(connectionId);
  if (
    !connection ||
    signal.aborted ||
    !["maxai", "mx"].includes(resolveProviderSlug(connection as Record<string, unknown>))
  )
    return maxaiLoginFailure(400);
  const rawPsd = connection.providerSpecificData;
  const psd =
    rawPsd && typeof rawPsd === "object" && !Array.isArray(rawPsd)
      ? (rawPsd as Record<string, unknown>)
      : {};

  if (data.step === "request") {
    const identity = maxaiLoginIdentitySchema.safeParse({
      email: data.email,
      deviceId: psd.maxaiDeviceId ?? psd.deviceId ?? randomUUID(),
      clientUserId: psd.maxaiClientUserId ?? psd.clientUserId ?? randomUUID(),
    });
    if (!identity.success) return maxaiLoginFailure(400);
    const { email, deviceId, clientUserId } = identity.data;
    try {
      const saved = await updateProviderConnection(connectionId, {
        providerSpecificData: {
          ...psd,
          maxaiDeviceId: deviceId,
          maxaiClientUserId: clientUserId,
          maxaiLoginEmail: email,
        },
      });
      // updateProviderConnection returns null if the row disappeared; no throw is not success.
      if (!saved) return maxaiLoginFailure(500);
    } catch (error) {
      if (isRuntimePolicyError(error)) throw error;
      return maxaiLoginFailure(500);
    }
    if (signal.aborted) return maxaiLoginFailure(400);
    const result = await requestMaxaiEmailCode({ email, deviceId, signal });
    if (!result.ok) return maxaiLoginFailure(400);
    return NextResponse.json({
      success: true,
      step: "request",
      message: "A sign-in code was emailed. Enter it to finish connecting.",
      email,
    });
  }

  const pending = maxaiLoginIdentitySchema.safeParse({
    email: psd.maxaiLoginEmail,
    deviceId: psd.maxaiDeviceId,
    clientUserId: psd.maxaiClientUserId,
  });
  if (
    !pending.success ||
    !data.code ||
    (data.email && data.email.toLowerCase() !== pending.data.email.toLowerCase())
  )
    return maxaiLoginFailure(400);

  const result = await verifyMaxaiEmailCode({ ...pending.data, code: data.code, signal });
  if (!result.ok || !result.credential || signal.aborted) return maxaiLoginFailure(400);
  const cred = result.credential;
  try {
    const saved = await updateProviderConnection(connectionId, {
      // Only these top-level fields pass through credential encryption at rest.
      apiKey: cred.accessToken,
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      providerSpecificData: {
        ...maxaiIdentityData(psd),
        maxaiDeviceId: pending.data.deviceId,
        maxaiUserId: cred.userId,
        maxaiClientUserId: pending.data.clientUserId,
        maxaiLoginEmail: pending.data.email,
        signedInAt: Date.now(),
      },
    });
    if (!saved) return maxaiLoginFailure(500);
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    return maxaiLoginFailure(500);
  }
  return NextResponse.json({
    success: true,
    step: "verify",
    persisted: true,
    account: pending.data.email,
    message: "MaxAI is connected.",
  });
}

// --- POST: Start login flow -------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const auth = await requireManagementAuth(req);
  if (auth) return auth;

  const { id } = await params;
  const provider = await getCachedProviderConnectionById(id);
  if (!provider) {
    return NextResponse.json({ success: false, error: "Provider not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    timeout?: unknown;
    freshSession?: unknown;
  };
  const providerSlug = resolveProviderSlug(provider as Record<string, unknown>);

  // MaxAI: browserless email device-pair login (no browser). Two-step:
  // {step:"request",email} emails a code; {step:"verify",code} mints + persists.
  if (providerSlug === "maxai" || providerSlug === "mx") {
    try {
      const { runMaxaiConnectionTransport } =
        await import("@omniroute/open-sse/services/maxaiTransport.ts");
      return await runMaxaiConnectionTransport(id, () => loginMaxaiEmail(id, body, req.signal));
    } catch (error) {
      if (isRuntimePolicyError(error)) return runtimePolicyErrorResponse();
      return maxaiLoginFailure(500);
    }
  }

  // Adobe Firefly: dedicated JWT capture (never cookies/localStorage alone).
  if (isAdobeFireflyProvider(provider as { provider?: unknown }, providerSlug)) {
    try {
      return await loginAdobeFirefly(id, body);
    } catch (err) {
      const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
      return NextResponse.json(
        { success: false, error: `Adobe Firefly sign-in error: ${msg}` },
        { status: 500 }
      );
    }
  }

  // Conol: unofficial browser-session chat with cookie auth
  // (__Secure-better-auth.session_token). Dedicated browser login + credential
  // persistence (same shape as the other web-cookie providers).
  if (providerSlug === "conol-web" || providerSlug === "cnl") {
    try {
      const { startConolBrowserLogin } =
        await import("@omniroute/open-sse/services/conolBrowserLogin.ts");
      const result = await startConolBrowserLogin(
        typeof body.timeout === "number" ? body.timeout : undefined
      );
      if (!result.success || !result.credentials) {
        return NextResponse.json(result, { status: 400 });
      }
      try {
        await updateProviderConnection(id, {
          apiKey: JSON.stringify(result.credentials),
          providerSpecificData: result.credentials,
        });
      } catch (err) {
        const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
        return NextResponse.json(
          { success: false, error: `Extracted but failed to persist: ${msg}` },
          { status: 500 }
        );
      }
      return NextResponse.json({
        success: true,
        credentials: result.credentials,
        persisted: true,
      });
    } catch (err) {
      const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
      return NextResponse.json(
        { success: false, error: `Login endpoint error: ${msg}` },
        { status: 500 }
      );
    }
  }

  try {
    // Generic web-cookie path: pass the provider SLUG (not the DB id) so
    // TOKEN_EXTRACTION_CONFIGS can find the extraction config.
    // Bug: the previous code passed `id` (connection UUID), so the lookup always
    // missed and returned "No extraction config" without launching a browser.
    const { inAppLoginService } = await import("@omniroute/open-sse/services/inAppLoginService.ts");

    const result = await inAppLoginService.startLogin(providerSlug || id, {
      timeout: clampLoginTimeoutMs(body.timeout),
    });

    // Persist credentials if extraction succeeded
    if (result.success && result.credentials) {
      try {
        const credentialsStr = JSON.stringify(result.credentials);
        await updateProviderConnection(id, {
          apiKey: credentialsStr,
          providerSpecificData: result.credentials,
        });

        return NextResponse.json({
          success: true,
          credentials: result.credentials,
          persisted: true,
        });
      } catch (err) {
        // Hard Rule #12: never put raw err.message/stack in a response body.
        const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
        return NextResponse.json(
          { success: false, error: `Extracted but failed to persist: ${msg}` },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(result, {
      status: result.success ? 200 : 400,
    });
  } catch (err) {
    // Hard Rule #12: never put raw err.message/stack in a response body.
    const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: `Login endpoint error: ${msg}` },
      { status: 500 }
    );
  }
}
