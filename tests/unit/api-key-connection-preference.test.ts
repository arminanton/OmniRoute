import test from "node:test";
import assert from "node:assert/strict";
import { selectCredentialWithConnectionPreference } from "../../src/sse/services/connectionPreference.ts";
import {
  createKeySchema,
  updateKeyPermissionsSchema,
} from "../../src/shared/validation/schemas/keys.ts";

const preferred = "00000000-0000-4000-8000-000000000001";
const fallback = "00000000-0000-4000-8000-000000000002";
const denied = "00000000-0000-4000-8000-000000000003";

test("tries authorized preferences in order, then falls back after an unhealthy preference", async () => {
  const attempts: (string[] | null)[] = [];
  const selected = await selectCredentialWithConnectionPreference({
    preferredConnections: [preferred, fallback],
    allowedConnections: [preferred, fallback],
    select: async (connections) => {
      attempts.push(connections);
      if (connections?.[0] === preferred) return null;
      if (connections?.[0] === fallback) return { id: fallback };
      return null;
    },
  });

  assert.deepEqual(attempts, [[preferred], [fallback]]);
  assert.deepEqual(selected, { id: fallback });
});

test("skips denied preferences and preserves normal routing when preferences are absent", async () => {
  const attempts: (string[] | null)[] = [];
  const fallbackSelection = await selectCredentialWithConnectionPreference({
    preferredConnections: [denied],
    allowedConnections: [fallback],
    select: async (connections) => {
      attempts.push(connections);
      return { connections };
    },
  });
  assert.deepEqual(attempts, [[fallback]]);
  assert.deepEqual(fallbackSelection, { connections: [fallback] });

  attempts.length = 0;
  await selectCredentialWithConnectionPreference({
    allowedConnections: [fallback, preferred],
    select: async (connections) => {
      attempts.push(connections);
      return null;
    },
  });
  assert.deepEqual(attempts, [[fallback, preferred]]);
});

test("bounds and validates preference order", () => {
  const ids = Array.from(
    { length: 101 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
  );
  assert.equal(
    createKeySchema.safeParse({ name: "key", preferredConnections: ids }).success,
    false
  );
  assert.equal(
    updateKeyPermissionsSchema.safeParse({ preferredConnections: [preferred, preferred] }).success,
    false
  );
  assert.equal(
    updateKeyPermissionsSchema.safeParse({ preferredConnections: [preferred, fallback] }).success,
    true
  );
});
