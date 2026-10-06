import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-paired-canary-"));
process.env.DATA_DIR = path.join(directory, "app");
process.env.API_KEY_SECRET = "synthetic-canary-manager-crc";
process.env.STORAGE_ENCRYPTION_KEY = "synthetic-canary-private-state-key";
const core = await import("../../src/lib/db/core.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const actor = await keys.createApiKey("canary fixture", "fixture-machine", ["manage"]);
const processes: ChildProcess[] = [];
const stateFile = path.join(directory, "coordination.sqlite");
async function node(generation: string, encryption = process.env.STORAGE_ENCRYPTION_KEY!) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "tests/fixtures/canary-conversation-http-node.ts"],
    {
      env: {
        ...process.env,
        OMNIROUTE_APP_GENERATION: generation,
        OMNI_SHARED_ADMISSION: "true",
        OMNI_COORDINATION_DB: stateFile,
        STORAGE_ENCRYPTION_KEY: encryption,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  processes.push(child);
  const result = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("fixture startup timed out")), 15000);
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n")) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.port && parsed.pid) {
            clearTimeout(timer);
            resolve(parsed);
            return;
          }
        } catch {
          /* DB startup diagnostics are not response payloads. */
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited:${code}`));
    });
  });
  return { url: `http://127.0.0.1:${result.port}`, generation, pid: result.pid };
}
async function request(
  server: { url: string },
  method = "GET",
  payload?: unknown,
  key: string | null = actor.key
) {
  const response = await fetch(server.url + "/api/canary-readiness", {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      "Content-Type": "application/json",
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json();
  return { response, body };
}
test.after(() => {
  for (const child of processes) child.kill("SIGTERM");
  core.resetDbInstance();
  fs.rmSync(directory, { recursive: true, force: true });
});

test(
  "two real app HTTP processes prove both directions with manager auth and immutable generation binding",
  { timeout: 40000 },
  async () => {
    const old = await node("a".repeat(32)),
      candidate = await node("b".repeat(32));
    assert.notEqual(old.pid, candidate.pid);
    const first = await request(old),
      second = await request(candidate);
    assert.equal(first.body.coordination.conversationState, false);
    assert.equal(second.body.coordination.conversationState, false);
    assert.equal(first.response.headers.get("X-Omni-App-Generation"), old.generation);
    assert.equal((await request(old, "GET", undefined, null)).response.status, 401);
    const own = await request(old, "POST", {
      generation: old.generation,
      peerChallengeId: first.body.conversationState.challengeId,
    });
    assert.equal(own.response.status, 409);
    const staleGeneration = await request(candidate, "POST", {
      generation: old.generation,
      peerChallengeId: first.body.conversationState.challengeId,
    });
    assert.equal(staleGeneration.response.status, 409);
    const one = await request(old, "POST", {
      generation: old.generation,
      peerChallengeId: second.body.conversationState.challengeId,
    });
    const two = await request(candidate, "POST", {
      generation: candidate.generation,
      peerChallengeId: first.body.conversationState.challengeId,
    });
    assert.equal(one.response.status, 200);
    assert.equal(two.response.status, 200);
    assert.equal(one.body.peerGeneration, candidate.generation);
    assert.equal(two.body.peerGeneration, old.generation);
    const left = await request(old),
      right = await request(candidate);
    assert.equal(left.body.coordination.conversationState, true);
    assert.equal(right.body.coordination.conversationState, true);
    assert.equal(left.body.conversationState.handoffFresh, true);
    assert.equal(right.body.conversationState.handoffFresh, true);
    // Other capability/lifecycle fields remain actual unsupported values in this bare fixture.
    assert.equal(left.body.ready, false);
    assert.equal(left.body.conversationState.peerGeneration, candidate.generation);
  }
);

test(
  "wrong encryption, expired nonce and supplied fake booleans cannot produce proof",
  { timeout: 25000 },
  async () => {
    const producer = await node("c".repeat(32)),
      wrong = await node("d".repeat(32), "different-synthetic-canary-key");
    const data = await request(producer);
    assert.notEqual(
      (
        await request(wrong, "POST", {
          generation: wrong.generation,
          peerChallengeId: data.body.conversationState.challengeId,
        })
      ).response.status,
      200
    );
    assert.equal(
      (
        await request(producer, "POST", {
          generation: producer.generation,
          peerChallengeId: data.body.conversationState.challengeId,
          ready: true,
        })
      ).response.status,
      409
    );
    const db = new DatabaseSync(stateFile);
    const digest = createHash("sha256")
      .update(data.body.conversationState.challengeId)
      .digest("hex");
    db.prepare(
      "UPDATE conversation_state_records SET expires=? WHERE kind='handoff_challenge' AND key=?"
    ).run(Date.now() - 1, digest);
    db.close();
    assert.notEqual(
      (
        await request(wrong, "POST", {
          generation: wrong.generation,
          peerChallengeId: data.body.conversationState.challengeId,
        })
      ).response.status,
      200
    );
  }
);
