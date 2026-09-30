import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/errorSanitization.ts";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  assertLockedManagementAuthProvisioned,
  isRuntimePolicyError,
  markRuntimePolicyResponse,
  requiresLockedManagementAuth,
} from "@/shared/runtimePolicy";
import { assertRuntimePolicySettings } from "@/shared/runtimePolicySettings";
import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";
import { getSettings, getRuntimePolicySettingsCandidate, updateSettings } from "@/lib/db/settings";
import {
  hasManagementPasswordConfigured,
  hashManagementPassword,
} from "@/lib/auth/managementPassword";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { getNodeRuntimeSupport } from "@/shared/utils/nodeRuntimeSupport.ts";
import { updateRequireLoginSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

function getJwtSecret(): Uint8Array | null {
  const secret = process.env.JWT_SECRET?.trim();
  return secret ? new TextEncoder().encode(secret) : null;
}

async function checkSessionAuthenticated(): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("auth_token")?.value;
    const secret = getJwtSecret();
    if (!token || !secret) return false;
    await jwtVerify(token, secret);
    return true;
  } catch {
    return false;
  }
}

// Node.js compatibility check — reflect the supported secure runtime floors used by CLI/CI.
function getNodeCompatibility() {
  const { nodeVersion, nodeCompatible } = getNodeRuntimeSupport();
  return { nodeVersion, nodeCompatible };
}

function hasConfiguredPassword(settings: Record<string, unknown>) {
  return hasManagementPasswordConfigured(settings);
}

function isBootstrapSecurityWindow(settings: Record<string, unknown>) {
  return !hasConfiguredPassword(settings);
}

function runtimePolicyRejection(): Response {
  return markRuntimePolicyResponse(
    createErrorResponse({
      status: 403,
      message: "Operation denied by runtime policy",
      type: "invalid_request",
    })
  );
}

export async function GET() {
  const nodeInfo = getNodeCompatibility();
  try {
    const lockedManagementAuth = requiresLockedManagementAuth();
    const settings = await getSettings(
      lockedManagementAuth ? { autoCompleteSetup: false } : undefined
    );
    const requireLogin = lockedManagementAuth || settings.requireLogin !== false;
    const authenticated = await checkSessionAuthenticated();
    const hasPassword = hasManagementPasswordConfigured(settings);
    const setupComplete = !!settings.setupComplete;
    const oidcEnabled = !!settings.oidcEnabled;
    const oidcDisablePasswordLogin =
      oidcEnabled &&
      (settings.oidcDisablePasswordLogin === true ||
        isFeatureFlagEnabled("OMNIROUTE_OIDC_DISABLE_PASSWORD_LOGIN") ||
        process.env.OMNIROUTE_OIDC_DISABLE_PASSWORD_LOGIN === "true" ||
        process.env.OIDC_DISABLE_PASSWORD_LOGIN === "true");
    return NextResponse.json({
      authenticated,
      requireLogin,
      hasPassword,
      setupComplete,
      oidcEnabled,
      oidcDisablePasswordLogin,
      ...nodeInfo,
    });
  } catch (error) {
    if (isRuntimePolicyError(error)) return runtimePolicyRejection();
    console.error("[API] Error fetching require-login settings:", error);
    return NextResponse.json(
      {
        authenticated: false,
        requireLogin: true,
        hasPassword: true,
        setupComplete: true,
        oidcEnabled: false,
        oidcDisablePasswordLogin: false,
        ...nodeInfo,
      },
      { status: 200 }
    );
  }
}

/**
 * POST /api/settings/require-login — Set password and/or toggle requireLogin.
 * Unauthenticated bootstrap writes remain available only in standalone mode.
 */
export async function POST(request: Request) {
  try {
    const lockedManagementAuth = requiresLockedManagementAuth();
    if (lockedManagementAuth) {
      const rejection = await requireManagementAuth(request);
      if (rejection) return rejection;
    }

    const settings = await getSettings(
      lockedManagementAuth ? { autoCompleteSetup: false } : undefined
    );
    if (
      !lockedManagementAuth &&
      !isBootstrapSecurityWindow(settings) &&
      !(await isAuthenticated(request))
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let rawBody;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: {
            message: "Invalid request",
            details: [{ field: "body", message: "Invalid JSON body" }],
          },
        },
        { status: 400 }
      );
    }

    // Check the explicit replacement alone, including empty values, before
    // schema coercion or hashing can hide it behind an existing credential.
    if (
      lockedManagementAuth &&
      rawBody &&
      typeof rawBody === "object" &&
      !Array.isArray(rawBody) &&
      Object.hasOwn(rawBody, "password")
    ) {
      assertLockedManagementAuthProvisioned({ password: rawBody.password });
    }

    const validation = validateBody(updateRequireLoginSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { requireLogin, password } = validation.data;
    const updates: Record<string, unknown> = lockedManagementAuth ? { requireLogin: true } : {};

    if (typeof requireLogin === "boolean") {
      updates.requireLogin = requireLogin;
    }

    // Admit the complete candidate before any bcrypt or persistence effect.
    // Explicit false is denied; an omitted toggle uses the locked requirement.
    if (lockedManagementAuth) {
      assertRuntimePolicySettings(
        await getRuntimePolicySettingsCandidate({
          ...updates,
          ...(password !== undefined ? { password } : {}),
        })
      );
    }

    if (password) {
      updates.password = await hashManagementPassword(password);
    }

    await updateSettings(updates);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isRuntimePolicyError(error)) return runtimePolicyRejection();
    console.error("[API] Error updating require-login settings:", error);
    return NextResponse.json(
      {
        error: sanitizeErrorMessage(
          error instanceof Error ? error.message : "Failed to update settings"
        ),
      },
      { status: 500 }
    );
  }
}
