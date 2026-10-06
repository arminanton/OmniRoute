import assert from "node:assert/strict";
import test from "node:test";

import { buildOpencodeBackgroundHeaders } from "../../open-sse/utils/opencodeHeaders.ts";
import {
  fetchOpencodeQuota,
  invalidateOpencodeQuotaCache,
} from "../../open-sse/services/opencodeQuotaFetcher.ts";
import {
  PROVIDER_MODELS_CONFIG,
  type ProviderModelsHeaderContext,
} from "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts";

const SESSION_PATTERN = /^[a-f0-9]{16}$/;
const REQUEST_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function discoveryHeaders(
  providerId: string,
  context: ProviderModelsHeaderContext = {},
  token = "discovery-token"
): Record<string, string> {
  const buildHeaders = PROVIDER_MODELS_CONFIG[providerId]?.buildHeaders;
  assert.ok(buildHeaders, `${providerId} must use custom discovery headers`);
  return buildHeaders(token, context);
}

test("background headers use the OpenCode CLI identity", () => {
  const headers = buildOpencodeBackgroundHeaders({ seed: "connection-a" });
  assert.equal(headers["User-Agent"], "opencode");
  assert.equal(headers["x-opencode-client"], "desktop");
  assert.equal(headers["x-opencode-project"], "global");
  assert.match(headers["x-opencode-request"], REQUEST_PATTERN);
});

test("background session is stable and opaque for a seed", () => {
  const seed = "workspace-private-id";
  const first = buildOpencodeBackgroundHeaders({ seed });
  const second = buildOpencodeBackgroundHeaders({ seed });
  assert.equal(first["x-opencode-session"], second["x-opencode-session"]);
  assert.match(first["x-opencode-session"], SESSION_PATTERN);
  assert.ok(!Object.values(first).some((value) => value.includes(seed)));
});

test("different workspace seeds produce different sessions", () => {
  assert.notEqual(
    buildOpencodeBackgroundHeaders({ seed: "workspace-a" })["x-opencode-session"],
    buildOpencodeBackgroundHeaders({ seed: "workspace-b" })["x-opencode-session"]
  );
});

test("missing seed still gets a session id", () => {
  const first = buildOpencodeBackgroundHeaders();
  const second = buildOpencodeBackgroundHeaders({ seed: "  " });
  assert.ok(first["x-opencode-session"]);
  assert.ok(second["x-opencode-session"]);
  assert.notEqual(first["x-opencode-session"], second["x-opencode-session"]);
});

test("all OpenCode-family discovery entries carry identity headers", () => {
  for (const providerId of ["opencode", "opencode-zen", "opencode-go"]) {
    const headers = discoveryHeaders(providerId, { id: `connection-${providerId}` });
    assert.equal(headers["User-Agent"], "opencode");
    assert.match(headers["x-opencode-session"], SESSION_PATTERN);
    assert.match(headers["x-opencode-request"], REQUEST_PATTERN);
    assert.equal(headers.Authorization, "Bearer discovery-token");
  }
});

test("discovery session uses the stable connection id, not workspace metadata", () => {
  const first = discoveryHeaders("opencode-go", {
    id: "connection-a",
    providerSpecificData: { workspaceId: "workspace-a" },
  });
  const repeat = discoveryHeaders("opencode-go", {
    id: "connection-a",
    providerSpecificData: { openCodeGoWorkspaceId: "workspace-b" },
  });
  assert.equal(first["x-opencode-session"], repeat["x-opencode-session"]);
});

test("discovery falls back to the connection id when no workspace is set", () => {
  const first = discoveryHeaders("opencode", { id: "connection-a" });
  const repeat = discoveryHeaders("opencode", { id: "connection-a" });
  const other = discoveryHeaders("opencode", { id: "connection-b" });
  assert.equal(first["x-opencode-session"], repeat["x-opencode-session"]);
  assert.notEqual(first["x-opencode-session"], other["x-opencode-session"]);
});

test("quota fetch carries a stable connection identity without exposing its API key", async () => {
  const connectionId = `opencode-background-test-${Date.now()}`;
  const apiKey = "private-api-key";
  const discoverySession = discoveryHeaders("opencode-go", {
    id: connectionId,
    providerSpecificData: { openCodeGoWorkspaceId: "workspace-private-id" },
  })["x-opencode-session"];
  const originalFetch = globalThis.fetch;
  let requestHeaders: Record<string, string> | undefined;
  invalidateOpencodeQuotaCache(connectionId);
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestHeaders = init?.headers as Record<string, string>;
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  try {
    assert.equal(await fetchOpencodeQuota(connectionId, { apiKey }), null);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateOpencodeQuotaCache(connectionId);
  }
  assert.ok(requestHeaders);
  assert.match(requestHeaders["x-opencode-session"], SESSION_PATTERN);
  assert.equal(requestHeaders["x-opencode-session"], discoverySession);
  assert.ok(!requestHeaders["x-opencode-session"].includes(apiKey));
  assert.equal(requestHeaders.Authorization, `Bearer ${apiKey}`);
});
