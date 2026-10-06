import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireMany } from "../../open-sse/services/accountSemaphore.ts";
import { observeSharedAdmissionOutcome } from "../../open-sse/services/coordination/sharedSemaphore.ts";
import { classifyAdmissionFeedback } from "../../open-sse/services/coordination/overloadClassification.ts";
import {
  observeAdmissionStream,
  isHealthyAdmissionPayload,
} from "../../open-sse/handlers/chatCore/admissionResponseOutcome.ts";
import { wrapReadableStreamWithFinalize } from "../../open-sse/handlers/chatCore/streamFinalize.ts";
const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const completed = frame({
  type: "response.completed",
  response: { status: "completed", output: [] },
});

async function measured(
  body: ReadableStream<Uint8Array>,
  read: (body: ReadableStream<Uint8Array>) => Promise<void>
) {
  const dir = mkdtempSync(join(tmpdir(), "omni-admission-outcome-")),
    file = join(dir, "c.sqlite");
  const priorShared = process.env.OMNI_SHARED_ADMISSION,
    priorDb = process.env.OMNI_COORDINATION_DB;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = file;
  try {
    const release = await acquireMany(
      [{ key: "codex:response", maxConcurrency: 4, adaptive: true }],
      { onLeaseLost: () => {} }
    );
    const observed = observeAdmissionStream(body, (failure) => {
      observeSharedAdmissionOutcome(
        "codex:response",
        classifyAdmissionFeedback(failure.status, failure.message),
        0
      );
    });
    const wrapped = wrapReadableStreamWithFinalize(observed.body, (complete) => {
      if (complete && observed.healthy())
        observeSharedAdmissionOutcome("codex:response", "success", 10);
      release();
    });
    await read(wrapped);
    const db = new DatabaseSync(file);
    try {
      return JSON.parse(
        String(
          db
            .prepare("SELECT state FROM coordination_adaptation WHERE resource='codex:response'")
            .get()!.state
        )
      );
    } finally {
      db.close();
    }
  } finally {
    globalThis.__omniSharedCoordinator?.close();
    globalThis.__omniSharedCoordinator = undefined;
    if (priorShared === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = priorShared;
    if (priorDb === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = priorDb;
    rmSync(dir, { recursive: true, force: true });
  }
}
function bytes(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const data = encoder.encode(text);
      controller.enqueue(data.slice(0, 7));
      controller.enqueue(data.slice(7));
      controller.close();
    },
  });
}
async function drain(body: ReadableStream<Uint8Array>) {
  await new Response(body).text();
}

test("HTTP200 knownfailed/incomplete plus normalEOF never records adaptive healthy completion", async () => {
  for (const type of ["response.failed", "response.incomplete"]) {
    const text = frame({
      type,
      response: {
        status: type.split(".")[1],
        error: { code: "rate_limit_exceeded", message: "Too many concurrent requests" },
      },
    });
    const state = await measured(bytes(text), async (body) =>
      assert.equal(await new Response(body).text(), text)
    );
    assert.equal(state.windowCompleted, 0);
  }
});
test("named error event with numeric protocol status cannot contribute healthy growth", async () => {
  const text =
    "event: error\ndata: " +
    JSON.stringify({ code: 429, message: "Too many concurrent requests" }) +
    "\n\n";
  const state = await measured(bytes(text), drain);
  assert.equal(state.currentLimit, 2);
  assert.equal(state.windowCompleted, 0);
});

test("Google numeric429 error frame reduces actual shared capacity and cannot count as success", async () => {
  const text = frame({
    error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Too many concurrent requests" },
  });
  const state = await measured(bytes(text), drain);
  assert.equal(state.currentLimit, 2);
  assert.equal(state.windowCompleted, 0);
});
test("normal completedEOF counts healthy; error words inside generated content remain output", async () => {
  const text =
    frame({
      type: "response.output_text.delta",
      delta: "capacity error: Too many concurrent requests",
    }) + completed;
  const state = await measured(bytes(text), async (body) =>
    assert.equal(await new Response(body).text(), text)
  );
  assert.equal(state.currentLimit, 4);
  assert.equal(state.windowCompleted, 1);
});
test("cancelled and read-error streams do not count healthy even after a completed frame", async () => {
  const cancelled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(completed));
    },
  });
  assert.equal(
    (
      await measured(cancelled, async (body) => {
        const reader = body.getReader();
        await reader.read();
        await reader.cancel();
      })
    ).windowCompleted,
    0
  );
  const errored = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("synthetic read error"));
    },
  });
  assert.equal(
    (
      await measured(errored, async (body) => {
        await assert.rejects(drain(body), /synthetic read error/);
      })
    ).windowCompleted,
    0
  );
});
test("oversized unparsedframe conservatively suppresses growth while forwarding bytes unchanged", async () => {
  const text = frame({ type: "response.output_text.delta", delta: "x".repeat(70000) }) + completed;
  const state = await measured(bytes(text), async (body) =>
    assert.equal(await new Response(body).text(), text)
  );
  assert.equal(state.windowCompleted, 0);
});
test("nonstream JSON/SSE knownerrors are not healthy and ordinary response content is", () => {
  assert.equal(
    isHealthyAdmissionPayload(
      JSON.stringify({ error: { code: 429, message: "quota" } }),
      "application/json"
    ),
    false
  );
  assert.equal(
    isHealthyAdmissionPayload(
      frame({ error: { code: 429, message: "quota" } }),
      "text/event-stream"
    ),
    false
  );
  assert.equal(
    isHealthyAdmissionPayload(
      JSON.stringify({
        choices: [{ message: { content: "error capacity" }, finish_reason: "stop" }],
      }),
      "application/json"
    ),
    true
  );
  assert.equal(isHealthyAdmissionPayload("x".repeat(70000), "application/json"), false);
});
test("feedback observer failure never changes forwarded response bytes", async () => {
  const text = frame({ error: { code: 429, message: "quota" } });
  const observed = observeAdmissionStream(bytes(text), () => {
    throw new Error("synthetic observer unavailable");
  });
  assert.equal(await new Response(observed.body).text(), text);
  assert.equal(observed.healthy(), false);
});

test("unknown envelopes and pre-completionEOF do not fabricate successful provider work", async () => {
  const state = await measured(
    bytes(frame({ type: "response.created", response: { status: "in_progress" } })),
    drain
  );
  assert.equal(state.windowCompleted, 0);
  assert.equal(
    isHealthyAdmissionPayload(JSON.stringify({ undocumented: "complete" }), "application/json"),
    false
  );
  assert.equal(
    isHealthyAdmissionPayload(JSON.stringify({ status: "completed" }), "application/json"),
    false
  );
  assert.equal(
    isHealthyAdmissionPayload(
      JSON.stringify({ object: "response", status: "completed" }),
      "application/json"
    ),
    true
  );
  assert.equal(
    isHealthyAdmissionPayload(
      JSON.stringify({ type: "message", stop_reason: "end_turn", content: [] }),
      "application/json"
    ),
    true
  );
});
