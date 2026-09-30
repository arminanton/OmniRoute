/**
 * API Authentication Guard — Shared utility for protecting API routes.
 *
 * Management APIs require a dashboard session, while client-facing APIs may still
 * accept Bearer API keys. Route scope is inferred from the request pathname.
 *
 * @module shared/utils/apiAuth
 */

import { jwtVerify } from "jose";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/db/settings";
import { classifyRoute } from "@/server/authz/classify";
import { requiresLockedManagementAuth } from "@/shared/runtimePolicy";
import { isPublicApiRoute } from "@/shared/constants/publicApiRoutes";
import { extractApiKey } from "@/sse/services/auth";

type RequestLike = {
  cookies?: {
    get?: (name: string) => { value?: string } | undefined;
  };
  headers?: Headers;
  method?: string;
  nextUrl?: { hostname?: string | null; pathname?: string | null } | null;
  url?: string;
};

const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1"]);

function hasConfiguredPassword(settings: Record<string, unknown>): boolean {
  return typeof settings.password === "string" && settings.password.length > 0;
}
function hasConfiguredOidc(settings: Record<string, unknown>): boolean {
  return (
    settings.oidcEnabled === true &&
    typeof settings.oidcIssuer === "string" &&
    settings.oidcIssuer.trim().length > 0 &&
    typeof settings.oidcClientId === "string" &&
    settings.oidcClientId.trim().length > 0 &&
    typeof settings.oidcClientSecret === "string" &&
    settings.oidcClientSecret.trim().length > 0
  );
}

function getRequestPathname(request: RequestLike | Request | null | undefined): string | null {
  const nextPathname =
    request &&
    typeof request === "object" &&
    "nextUrl" in request &&
    request.nextUrl &&
    typeof request.nextUrl.pathname === "string"
      ? request.nextUrl.pathname
      : null;

  if (nextPathname) return nextPathname;

  const rawUrl =
    request && typeof request === "object" && "url" in request && typeof request.url === "string"
      ? request.url
      : "";

  if (!rawUrl) return null;

  try {
    return new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return null;
  }
}

function isOnboardingBootstrapPath(pathname: string | null): boolean {
  return pathname === "/dashboard/onboarding";
}

function isRequireLoginBootstrapWritePath(pathname: string | null, method: string): boolean {
  return pathname === "/api/settings/require-login" && method.toUpperCase() === "POST";
}

function getRequestMethod(request: RequestLike | Request | null | undefined): string {
  if (
    request &&
    typeof request === "object" &&
    "method" in request &&
    typeof request.method === "string"
  ) {
    return request.method.toUpperCase();
  }
  return "GET";
}

function getRequestHostname(request: RequestLike | Request | null | undefined): string | null {
  const nextHostname =
    request &&
    typeof request === "object" &&
    "nextUrl" in request &&
    request.nextUrl &&
    typeof request.nextUrl.hostname === "string"
      ? request.nextUrl.hostname
      : null;

  if (nextHostname) return nextHostname;

  const rawUrl =
    request && typeof request === "object" && "url" in request && typeof request.url === "string"
      ? request.url
      : "";

  if (rawUrl) {
    try {
      return new URL(rawUrl, "http://localhost").hostname;
    } catch {
      // Fall through to Host header parsing.
    }
  }

  const requestHeaders =
    request && typeof request === "object" && "headers" in request ? request.headers : undefined;
  const host = requestHeaders?.get("host") || requestHeaders?.get("Host") || null;
  if (!host) return null;

  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host.split(":")[0] || null;
  }
}

export function isLoopbackRequest(request: RequestLike | Request | null | undefined): boolean {
  const hostname = getRequestHostname(request);
  if (!hostname) return false;

  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (LOOPBACK_HOSTNAMES.has(normalized)) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return true;
  return false;
}

function getCookieValueFromHeader(headers: Headers | undefined, name: string): string | null {
  const cookieHeader = headers?.get("cookie") || headers?.get("Cookie");
  if (!cookieHeader) return null;

  for (const segment of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = segment.split("=");
    if (!rawKey || rawValue.length === 0) continue;
    if (rawKey.trim() !== name) continue;
    return rawValue.join("=").trim();
  }

  return null;
}

function getRequestApiKey(
  request: RequestLike | Request | null | undefined,
  opts?: { allowUrl?: boolean }
): string | null {
  if (!request || typeof request !== "object") return null;

  const headers = "headers" in request ? request.headers : undefined;
  const rawUrl = "url" in request && typeof request.url === "string" ? request.url : null;
  const pathname = getRequestPathname(request);
  const syntheticUrl = rawUrl || (pathname ? `http://localhost${pathname}` : null);

  // Management auth never honours a URL-borne credential (defence-in-depth: the
  // path-scoped token is a client-API affordance only — a credential in the URL
  // must not authenticate a management route). See the #3300 security follow-up.
  const allowUrl = opts?.allowUrl !== false;

  return extractApiKey({ headers, url: allowUrl ? syntheticUrl : null }, { allowUrl });
}

async function validateBearerApiKey(apiKey: string | null): Promise<boolean> {
  if (!apiKey) return false;

  try {
    const { validateApiKey } = await import("@/lib/db/apiKeys");
    return await validateApiKey(apiKey);
  } catch {
    return false;
  }
}

/**
 * Check whether a Bearer API key is valid AND carries a scope that authorizes
 * it on management API routes (`/api/*` excluding `/api/v1/*` and the public
 * allowlist). Returns `false` for unscoped keys so that the existing
 * default-deny posture on management routes is preserved.
 *
 * Scope set is sourced from `@/shared/constants/managementScopes` so this
 * helper stays in lockstep with `requireManagementAuth.hasManageScope`.
 */
async function validateBearerApiKeyForManagement(apiKey: string | null): Promise<boolean> {
  if (!apiKey) return false;

  try {
    const [{ validateApiKey, getApiKeyMetadata }, { hasManageScope }] = await Promise.all([
      import("@/lib/db/apiKeys"),
      import("@/shared/constants/managementScopes"),
    ]);
    const valid = await validateApiKey(apiKey);
    if (!valid) return false;

    const metadata = await getApiKeyMetadata(apiKey);
    if (!metadata) return false;

    return hasManageScope(metadata.scopes);
  } catch {
    return false;
  }
}

function isClientApiRequest(request: RequestLike | Request | null | undefined): boolean {
  const pathname = getRequestPathname(request);
  return (
    !!pathname && classifyRoute(pathname, getRequestMethod(request)).routeClass === "CLIENT_API"
  );
}

export function isManagementApiRequest(request: RequestLike | Request): boolean {
  // Public routes remain public in the central pipeline. If their handler
  // explicitly asks for auth (e.g. an OAuth credential write), locked mode
  // requires a management credential rather than an inference-only key.
  if (requiresLockedManagementAuth()) return !isClientApiRequest(request);
  const pathname = getRequestPathname(request);
  if (!pathname?.startsWith("/api/")) return false;
  if (pathname.startsWith("/api/v1/")) return false;
  return !isPublicApiRoute(pathname, getRequestMethod(request));
}

export async function isDashboardSessionAuthenticated(
  request?: RequestLike | Request | null
): Promise<boolean> {
  if (!process.env.JWT_SECRET) return false;

  let token =
    request &&
    typeof request === "object" &&
    "cookies" in request &&
    request.cookies?.get?.("auth_token")?.value
      ? request.cookies.get("auth_token")?.value || null
      : null;

  const requestHeaders =
    request && typeof request === "object" && "headers" in request ? request.headers : undefined;

  if (!token) {
    token = getCookieValueFromHeader(requestHeaders, "auth_token");
  }

  if (!token) {
    try {
      const cookieStore = await cookies();
      token = cookieStore.get("auth_token")?.value || null;
    } catch {
      token = null;
    }
  }

  if (!token) return false;

  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET);
    await jwtVerify(token, secret);
    return true;
  } catch {
    return false;
  }
}

// ──────────────── Auth Verification ────────────────

/**
 * Check if a request is authenticated.
 *
 * @returns null if authenticated, error message string if not
 */
export async function verifyAuth(request: any): Promise<string | null> {
  // Read policy even when a valid dashboard cookie is present.
  const isManagement = isManagementApiRequest(request);
  if (await isDashboardSessionAuthenticated(request)) {
    return null;
  }

  const apiKey = getRequestApiKey(request, { allowUrl: !isManagement });
  if (isManagement) {
    if (await validateBearerApiKeyForManagement(apiKey)) {
      return null;
    }
    return apiKey ? "Invalid management token" : "Authentication required";
  }

  if (await validateBearerApiKey(apiKey)) {
    return null;
  }

  return "Authentication required";
}

/**
 * Check if a request is authenticated — boolean convenience wrapper for route handlers.
 *
 * Uses `cookies()` from next/headers (App Router compatible) and Bearer API key.
 * Returns true if authenticated, false otherwise.
 *
 * Unlike `verifyAuth`, this honors `isAuthRequired()` and its standalone
 * bootstrap behavior. Locked management requests never skip auth.
 */
export async function isAuthenticated(request: Request): Promise<boolean> {
  // If settings say login/auth is disabled, treat all requests as authenticated
  if (!(await isAuthRequired(request))) {
    return true;
  }

  if (await isDashboardSessionAuthenticated(request)) {
    return true;
  }

  const isManagement = isManagementApiRequest(request);
  const apiKey = getRequestApiKey(request, { allowUrl: !isManagement });
  if (isManagement) {
    return validateBearerApiKeyForManagement(apiKey);
  }

  return validateBearerApiKey(apiKey);
}

/**
 * Check if a route is in the public (no-auth) allowlist.
 */
export function isPublicRoute(pathname: string, method = "GET"): boolean {
  return isPublicApiRoute(pathname, method);
}

/**
 * Check if authentication is required based on settings.
 * If requireLogin is explicitly false, auth is skipped. Fresh installs without
 * a password keep their unauthenticated bootstrap path only on loopback
 * requests; exposed network requests must configure INITIAL_PASSWORD or log in.
 * Locked management ignores both bypasses. Client API defaults are unchanged.
 */
export async function isAuthRequired(
  request?: RequestLike | Request | null | undefined
): Promise<boolean> {
  // Outside the settings catch: invalid required policy must propagate, not be
  // downgraded to an ordinary auth decision. No request means management here.
  if (requiresLockedManagementAuth() && !isClientApiRequest(request)) return true;

  try {
    const settings = await getSettings();
    if (settings.requireLogin === false) return false;

    if (
      !hasConfiguredPassword(settings) &&
      !hasConfiguredOidc(settings) &&
      !process.env.INITIAL_PASSWORD
    ) {
      if (!request) return false;

      const pathname = getRequestPathname(request);
      const method = getRequestMethod(request);
      if (isOnboardingBootstrapPath(pathname)) {
        return false;
      }

      if (pathname && isPublicApiRoute(pathname, method)) {
        return false;
      }

      if (isRequireLoginBootstrapWritePath(pathname, method)) {
        return false;
      }

      return settings.setupComplete === true || !isLoopbackRequest(request);
    }

    return true;
  } catch (error: any) {
    // On error, require auth (secure by default)
    // Log the error so failures (e.g., SQLITE_BUSY) aren't silent 401s
    console.error(
      "[API_AUTH_GUARD] isAuthRequired failed, defaulting to true:",
      error?.message || error
    );
    return true;
  }
}
