import test from "node:test";
import assert from "node:assert/strict";

const { egressIpLockProvidersFromEnv } =
  await import("../../open-sse/config/providerErrorRules.ts");

test("unset env keeps the default egress-IP lock providers", () => {
  assert.deepEqual([...egressIpLockProvidersFromEnv(undefined)].sort(), [
    "opencode",
    "opencode-cli",
    "opencode-go",
  ]);
});

test("unrelated providers are not egress-IP locked by default", () => {
  const providers = egressIpLockProvidersFromEnv(undefined);
  assert.equal(providers.has("openai"), false);
  assert.equal(providers.has("anthropic"), false);
});

test("none/off disable egress-IP lockout", () => {
  for (const value of ["none", "off", " NONE ", "OFF"]) {
    assert.equal(egressIpLockProvidersFromEnv(value).size, 0, value);
  }
});

test("CSV replaces defaults with normalized provider IDs and aliases", () => {
  const providers = egressIpLockProvidersFromEnv(" AgentRouter, OpenCode-CLI,agentrouter ");
  assert.deepEqual([...providers].sort(), ["agentrouter", "opencode-cli"]);
  assert.equal(providers.has("opencode-go"), false);
});
