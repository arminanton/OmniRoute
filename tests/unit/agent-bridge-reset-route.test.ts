/**
 * Unit tests: POST /api/tools/agent-bridge/agents/[id]/reset.
 * DNS writes are disabled; this suite never changes the real hosts file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OMNIROUTE_SKIP_DNS_WRITE = "1";
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-reset-"));
process.env.DATA_DIR = testDataDir;

const core = await import("../../src/lib/db/core.ts");
const stateDb = await import("../../src/lib/db/agentBridgeState.ts");
const mappingsDb = await import("../../src/lib/db/agentBridgeMappings.ts");
const resetRoute = await import("../../src/app/api/tools/agent-bridge/agents/[id]/reset/route.ts");

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(testDataDir, { recursive: true });
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeRequest(agentId: string, body: unknown = { sudoPassword: "test-sudo-password" }) {
  return new Request(`http://127.0.0.1/api/tools/agent-bridge/agents/${agentId}/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function withHostsFileContents<T>(contents: string, run: () => Promise<T>): Promise<T> {
  const mutableFs = fs as unknown as { readFileSync: (...args: unknown[]) => unknown };
  const originalReadFileSync = mutableFs.readFileSync;
  mutableFs.readFileSync = (...args: unknown[]) => {
    const filePath = String(args[0]).replace(/\\/g, "/").toLowerCase();
    if (filePath.endsWith("/hosts") || filePath === "hosts") return contents;
    return originalReadFileSync(...args);
  };

  try {
    return await run();
  } finally {
    mutableFs.readFileSync = originalReadFileSync;
  }
}

test("unknown agent returns 404 without a stack trace", async () => {
  const res = await resetRoute.POST(makeRequest("__unknown_agent__"), {
    params: Promise.resolve({ id: "__unknown_agent__" }),
  });
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.ok(text.includes("__unknown_agent__"));
  assert.ok(!text.includes("at /"));
});

test("malformed JSON returns 400", async () => {
  const req = new Request("http://127.0.0.1/api/tools/agent-bridge/agents/cursor/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  });
  const res = await resetRoute.POST(req, { params: Promise.resolve({ id: "cursor" }) });
  assert.equal(res.status, 400);
});

test("invalid body returns 400", async () => {
  const res = await resetRoute.POST(makeRequest("cursor", { sudoPassword: 123 }), {
    params: Promise.resolve({ id: "cursor" }),
  });
  assert.equal(res.status, 400);
});

test("clears only the selected agent state and mappings", async () => {
  stateDb.upsertAgentBridgeState({
    agent_id: "antigravity",
    dns_enabled: true,
    setup_completed: true,
  });
  mappingsDb.setMappings("antigravity", [
    { source: "gemini-pro", target: "anthropic/claude-sonnet-4" },
  ]);
  stateDb.upsertAgentBridgeState({ agent_id: "cursor", dns_enabled: true, setup_completed: true });
  mappingsDb.setMappings("cursor", [{ source: "gpt-4o", target: "openai/gpt-4o" }]);

  const res = await resetRoute.POST(makeRequest("antigravity"), {
    params: Promise.resolve({ id: "antigravity" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    verified: boolean;
    mappingsCleared: boolean;
    otherAgentsStillActive: boolean;
  };
  assert.equal(body.verified, true);
  assert.equal(body.mappingsCleared, true);
  assert.equal(body.otherAgentsStillActive, true);
  assert.equal(stateDb.getAgentBridgeState("antigravity")?.dns_enabled, false);
  assert.equal(stateDb.getAgentBridgeState("antigravity")?.setup_completed, false);
  assert.deepEqual(mappingsDb.getMappingsForAgent("antigravity"), []);
  assert.equal(stateDb.getAgentBridgeState("cursor")?.dns_enabled, true);
  assert.equal(stateDb.getAgentBridgeState("cursor")?.setup_completed, true);
  assert.equal(mappingsDb.getMappingsForAgent("cursor").length, 1);
});

test("resets mappings when DNS and setup flags are absent", async () => {
  mappingsDb.setMappings("cursor", [{ source: "gpt-4o", target: "openai/gpt-4o" }]);

  const res = await resetRoute.POST(makeRequest("cursor"), {
    params: Promise.resolve({ id: "cursor" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { verified: boolean; mappingsCleared: boolean };
  assert.equal(body.verified, true);
  assert.equal(body.mappingsCleared, true);
  assert.deepEqual(mappingsDb.getMappingsForAgent("cursor"), []);
  assert.equal(stateDb.getAgentBridgeState("cursor")?.dns_enabled, false);
  assert.equal(stateDb.getAgentBridgeState("cursor")?.setup_completed, false);
});

test("does not verify reset when a partial IPv4 or IPv6 DNS entry remains", async () => {
  for (const hostEntry of ["127.0.0.1 api2.cursor.sh", "::1 api2.cursor.sh"]) {
    const res = await withHostsFileContents(`${hostEntry}\n`, () =>
      resetRoute.POST(makeRequest("cursor"), { params: Promise.resolve({ id: "cursor" }) })
    );
    assert.equal(res.status, 500);
    const body = (await res.json()) as {
      error?: { details?: { verified?: boolean; dnsEntriesRemain?: boolean | null } };
    };
    assert.equal(body.error?.details?.verified, false);
    assert.equal(body.error?.details?.dnsEntriesRemain, true);
  }
});

test("preserves a shared DNS host required by an active sibling agent", async () => {
  stateDb.upsertAgentBridgeState({ agent_id: "kiro", dns_enabled: true, setup_completed: true });

  const res = await withHostsFileContents("::1 api.anthropic.com\n", () =>
    resetRoute.POST(makeRequest("claude-code"), {
      params: Promise.resolve({ id: "claude-code" }),
    })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    verified: boolean;
    dnsHostsPreservedForOtherAgents: string[];
    otherAgentsStillActive: boolean;
  };
  assert.equal(body.verified, true);
  assert.deepEqual(body.dnsHostsPreservedForOtherAgents, ["api.anthropic.com"]);
  assert.equal(body.otherAgentsStillActive, true);
  assert.equal(stateDb.getAgentBridgeState("kiro")?.dns_enabled, true);
});

test("does not return success when reset fails", async () => {
  stateDb.upsertAgentBridgeState({ agent_id: "cursor", dns_enabled: true, setup_completed: true });
  mappingsDb.setMappings("cursor", [{ source: "gpt-4o", target: "openai/gpt-4o" }]);
  core.getDbInstance().prepare("DROP TABLE agent_bridge_mappings").run();

  const res = await resetRoute.POST(makeRequest("cursor"), {
    params: Promise.resolve({ id: "cursor" }),
  });
  assert.equal(res.status, 500);
  const body = (await res.json()) as { ok?: boolean; error?: { details?: { verified?: boolean } } };
  assert.notEqual(body.ok, true);
  assert.equal(body.error?.details?.verified, false);
});
