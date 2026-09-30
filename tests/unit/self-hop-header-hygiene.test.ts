import test from "node:test";
import assert from "node:assert/strict";
import { redactLogArgs, redactSecrets } from "../../src/shared/utils/logRedaction.ts";
import { redactPayload } from "../../src/lib/logPayloads.ts";
import { createRequestLogger } from "../../open-sse/utils/requestLogger.ts";
import {
  isForbiddenCustomHeaderName,
  isForbiddenUpstreamHeaderName,
} from "../../src/shared/constants/upstreamHeaders.ts";
import { sanitizeUpstreamHeadersMap } from "../../src/lib/db/models.ts";

const token = "f1".repeat(32);
const name = "X-Omniroute-Self-Hop";
test("self-hop proof is fully redacted from structured logs and request artifacts", async () => {
  assert.equal(
    JSON.stringify(redactLogArgs([{ headers: { [name]: token } }])).includes(token),
    false
  );
  assert.equal(
    JSON.stringify(redactPayload({ headers: { [name]: token } })).includes(token),
    false
  );
  const logger = await createRequestLogger("test", "test", "test-model", { enabled: true });
  logger.logClientRawRequest("/v1/chat/completions", {}, { [name]: token });
  const captured = JSON.stringify(logger.getPipelinePayloads());
  assert.equal(captured.includes(token), false);
  assert.equal(captured.includes(token.slice(0, 10)), false, "no partial bearer prefix");
});

test("self-hop proof is fully redacted from header and serialized-log strings", () => {
  for (const text of [
    `${name}: ${token}`,
    `x-omniroute-self-hop=${token}`,
    JSON.stringify({ "x-omniroute-self-hop": token }),
  ]) {
    assert.equal(redactSecrets(text).includes(token), false);
  }
});

test("reserved internal header cannot be configured as a provider upstream header", () => {
  assert.equal(isForbiddenUpstreamHeaderName(name), true);
  assert.equal(isForbiddenCustomHeaderName(name), true);
  assert.deepEqual(sanitizeUpstreamHeadersMap({ [name]: token, "X-Custom": "ok" }), {
    "X-Custom": "ok",
  });
});

test("validation schema rejects the reserved hop header too", async () => {
  const { upstreamHeaderNameSchema } = await import("../../src/shared/validation/schemas/misc.ts");
  assert.equal(upstreamHeaderNameSchema.safeParse(name).success, false);
});

test.after(async () => {
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
});
