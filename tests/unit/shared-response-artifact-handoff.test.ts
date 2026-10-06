import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-artifact-handoff-"));
process.env.API_KEY_SECRET = "synthetic-artifact-key-crc-secret";
process.env.DATA_DIR = path.join(directory, "app");
process.env.OMNI_SHARED_ADMISSION = "true";
process.env.OMNI_COORDINATION_DB = path.join(directory, "state.sqlite");
process.env.STORAGE_ENCRYPTION_KEY = "synthetic-artifact-handoff-key";
const core = await import("../../src/lib/db/core.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const logs = await import("../../src/lib/usage/callLogs.ts");
const resolver = await import("../../src/lib/db/responsesContinuationStore.ts");
const shared = await import("../../src/lib/db/sharedConversationState.ts");
const child = promisify(execFile);
test.after(async () => {
  await logs.closeCallLogSaves();
  shared.closeSharedConversationStateForTests();
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("published retained artifact reconstructs a tool turn after handoff to a different process", async () => {
  const key = await keys.createApiKey("fixture", "machine");
  const input = [{ role: "user", content: "synthetic retained tool fixture" }];
  const output = [
    {
      type: "function_call",
      call_id: "handoff-call",
      name: "read_file",
      arguments: '{"path":"/fixture"}',
    },
  ];
  await logs.saveCallLog({
    id: "handoff-log",
    method: "POST",
    path: "/v1/responses",
    status: 200,
    provider: "openai",
    model: "model",
    requestedModel: "openai/model",
    apiKeyId: key.id,
    responseId: "handoff-response",
    requestBody: { input },
    responseBody: { output, status: "completed" },
    pipelinePayloads: {
      clientRawRequest: { endpoint: "/v1/responses", effectiveInput: input },
      clientResponse: { output, status: "completed" },
    },
  });
  // Remove the local lookup row to prove the other process uses shared encrypted functional state.
  core.getDbInstance().prepare("DELETE FROM call_logs WHERE response_id=?").run("handoff-response");
  const { stdout } = await child(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "tests/fixtures/shared-conversation-state-worker.ts",
      "resolve-continuation",
      "handoff-response",
      key.id,
      "openai/model",
    ],
    { env: { ...process.env }, timeout: 15000 }
  );
  const read = JSON.parse(stdout.trim().split("\n").at(-1)!).result;
  assert.deepEqual(read, { input, output });
  const delta = {
    type: "function_call_output",
    call_id: "handoff-call",
    output: "synthetic tool result",
  };
  assert.deepEqual(
    [...read.input, ...read.output, delta].map((item) => item.call_id).filter(Boolean),
    ["handoff-call", "handoff-call"]
  );
  assert.equal(
    resolver.resolvePreviousResponseState("handoff-response", key.id, "openai/other-model"),
    null
  );
  core.getDbInstance().prepare("UPDATE api_keys SET no_log=1 WHERE id=?").run(key.id);
  assert.equal(
    resolver.resolvePreviousResponseState("handoff-response", key.id, "openai/model"),
    null
  );
});
