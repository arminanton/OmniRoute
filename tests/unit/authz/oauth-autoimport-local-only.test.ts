import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicApiRoute } from "../../../src/shared/constants/publicApiRoutes.ts";
import { classifyRoute } from "../../../src/server/authz/classify.ts";
import { isLocalOnlyPath } from "../../../src/server/authz/routeGuard.ts";

// GHSA-wgwc-crjm-pmwv / GHSA-gxv4-955v-v6cm — the OAuth auto-import routes read
// host-local credential files. They must NOT be PUBLIC (which skips the LOCAL_ONLY
// tier); they must classify MANAGEMENT and be loopback-gated.

const AUTO_IMPORT = ["/api/oauth/cursor/auto-import", "/api/oauth/kiro/auto-import"];

test("OAuth auto-import routes are excluded from PUBLIC classification", () => {
  for (const p of AUTO_IMPORT) {
    assert.equal(isPublicApiRoute(p), false, `${p} must not be PUBLIC`);
    assert.equal(classifyRoute(p, "GET").routeClass, "MANAGEMENT", `${p} must classify MANAGEMENT`);
  }
});

test("OAuth auto-import routes are LOCAL_ONLY (loopback-gated)", () => {
  for (const p of AUTO_IMPORT) {
    assert.equal(isLocalOnlyPath(p), true, `${p} must be LOCAL_ONLY`);
  }
});

test("OAuth browser flows use the management policy without broad public-prefix auth", () => {
  for (const path of [
    "/api/oauth/cursor/callback",
    "/api/oauth/codex/authorize",
    "/api/oauth/cursor/auto-import-status",
  ]) {
    assert.equal(isPublicApiRoute(path), false, `${path} is management-classified`);
    assert.equal(classifyRoute(path).routeClass, "MANAGEMENT", path);
  }
  // The actual public callback and ticket-gated login flows remain public.
  assert.equal(isPublicApiRoute("/api/auth/oidc/callback"), true);
  assert.equal(isPublicApiRoute("/api/codex/connect/device-ticket", "POST"), true);
});
