import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-comfy-video-deadline-"));

const { handleVideoGeneration } = await import("../../open-sse/handlers/videoGeneration.ts");
const {
  ComfyWorkflowSubmitError,
  createComfyWorkflowDeadline,
  fetchComfyOutput,
  pollComfyResult,
  submitComfyWorkflow,
} = await import("../../open-sse/utils/comfyuiClient.ts");

test("ComfyUI video deadline bounds an ambiguous submit and returns terminal 504", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let fireDeadline: (() => void) | undefined;
  let submitStarted!: () => void;
  const started = new Promise<void>((resolve) => (submitStarted = resolve));

  globalThis.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms === 300_000 && typeof callback === "function") {
      fireDeadline = () => callback(...args);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }
    if (typeof callback === "function") callback(...args);
    return 2 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.fetch = async (input) => {
    assert.ok(String(input).endsWith("/prompt"));
    submitStarted();
    return new Promise<Response>(() => {});
  };

  try {
    const pending = handleVideoGeneration({
      body: { model: "comfyui/animatediff", prompt: "deadline test" },
      credentials: null,
      log: null,
    });
    await started;
    assert.ok(fireDeadline, "handler must install its server-owned deadline timer");
    fireDeadline();

    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(result.status, 504);
    assert.equal(result.terminal, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("ComfyUI preserves a known 429 rejection when its error body hits the deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let fireDeadline: (() => void) | undefined;
  let submitStarted!: () => void;
  let errorBodyStarted!: () => void;
  const started = new Promise<void>((resolve) => (submitStarted = resolve));
  const errorBody = new Promise<void>((resolve) => (errorBodyStarted = resolve));
  globalThis.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms === 300_000 && typeof callback === "function") {
      fireDeadline = () => callback(...args);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  globalThis.fetch = async () => {
    const response = new Response(null, { status: 429 });
    response.text = () => {
      errorBodyStarted();
      return new Promise<string>(() => {});
    };
    submitStarted();
    return response;
  };

  try {
    const pending = handleVideoGeneration({
      body: { model: "comfyui/animatediff", prompt: "rate-limited" },
      credentials: null,
      log: null,
    });
    await started;
    await errorBody;
    assert.ok(fireDeadline);
    fireDeadline();
    const result = await pending;

    assert.equal(result.success, false);
    assert.equal(result.status, 429);
    assert.equal(result.terminal, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("ComfyUI does not dispatch a prompt after account admission has been lost", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  const admission = new AbortController();
  admission.abort(new Error("shared account lease lost"));
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("a prompt must not be submitted after lease loss");
  };

  try {
    const result = await handleVideoGeneration({
      body: { model: "comfyui/animatediff", prompt: "lease check" },
      credentials: null,
      log: null,
      signal: admission.signal,
      callerSignal: caller.signal,
      admissionSignal: admission.signal,
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.equal(result.terminal, true);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ComfyUI video observes an accepted prompt after caller disconnect, then returns terminal 499", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const caller = new AbortController();
  let historySignal: AbortSignal | undefined;
  let historyStarted!: () => void;
  let releaseHistory!: (response: Response) => void;
  const started = new Promise<void>((resolve) => (historyStarted = resolve));
  const historyGate = new Promise<Response>((resolve) => (releaseHistory = resolve));
  let viewCalls = 0;

  globalThis.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms === 300_000) return 3 as unknown as ReturnType<typeof setTimeout>;
    if (typeof callback === "function") callback(...args);
    return 3 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/prompt")) {
      return new Response(JSON.stringify({ prompt_id: "accepted-job" }), { status: 200 });
    }
    if (url.endsWith("/history/accepted-job")) {
      historySignal = init?.signal as AbortSignal | undefined;
      historyStarted();
      return historyGate;
    }
    if (url.includes("/view?")) {
      viewCalls += 1;
      return new Response(new Uint8Array([1]));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const pending = handleVideoGeneration({
      body: { model: "comfyui/animatediff", prompt: "accepted task" },
      credentials: null,
      log: null,
      signal: caller.signal,
      callerSignal: caller.signal,
    });
    await started;
    caller.abort();
    assert.equal(
      historySignal?.aborted,
      false,
      "caller cancellation must not abort accepted polling"
    );

    releaseHistory(
      new Response(
        JSON.stringify({
          "accepted-job": { outputs: { 7: { gifs: [{ filename: "result.webp" }] } } },
        }),
        { status: 200 }
      )
    );

    const result = await pending;
    assert.equal(result.success, false);
    assert.equal(result.status, 499);
    assert.equal(result.terminal, true);
    assert.equal(viewCalls, 0, "do not download artifacts after the caller has disconnected");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("ComfyUI submit response parsing is covered by the server-owned deadline", async () => {
  const originalFetch = globalThis.fetch;
  const deadline = createComfyWorkflowDeadline(20);
  globalThis.fetch = async () => {
    const response = new Response("{}", { status: 200 });
    response.json = () => new Promise<unknown>(() => {});
    return response;
  };

  try {
    await assert.rejects(
      submitComfyWorkflow("http://comfyui:8188", {}, null, deadline),
      (error: unknown) => {
        assert.ok(error instanceof ComfyWorkflowSubmitError);
        assert.equal(error.terminal, true);
        return true;
      }
    );
    assert.equal(deadline.expired, true);
  } finally {
    deadline.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("ComfyUI history fetch and output body reads are covered by the shared deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const historyController = new AbortController();
  const historyDeadlineAt = Date.now() + 10_000;
  const outputController = new AbortController();
  const outputDeadlineAt = Date.now() + 10_000;
  let historyStarted!: () => void;
  let outputStarted!: () => void;
  const historyGate = new Promise<void>((resolve) => (historyStarted = resolve));
  const outputGate = new Promise<void>((resolve) => (outputStarted = resolve));

  globalThis.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (typeof callback === "function") callback(...args);
    return 4 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/history/")) {
      historyStarted();
      const response = new Response("{}", { status: 200 });
      response.json = () => new Promise<unknown>(() => {});
      return response;
    }
    if (url.includes("/view?")) {
      outputStarted();
      const response = new Response(new Uint8Array([1]), { status: 200 });
      response.arrayBuffer = () => new Promise<ArrayBuffer>(() => {});
      return response;
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const historyRead = pollComfyResult("http://comfyui:8188", "job-2", 300_000, {
      signal: historyController.signal,
      deadlineAt: historyDeadlineAt,
    });
    await historyGate;
    historyController.abort(new Error("test workflow deadline"));
    await assert.rejects(historyRead);

    const outputRead = fetchComfyOutput(
      "http://comfyui:8188",
      "result.webp",
      "",
      "output",
      outputController.signal,
      { deadlineAt: outputDeadlineAt }
    );
    await outputGate;
    outputController.abort(new Error("test workflow deadline"));
    await assert.rejects(outputRead);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("ComfyUI cancels failed history-poll bodies before retrying", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let firstBodyCancelled = false;
  let calls = 0;
  globalThis.setTimeout = ((callback: TimerHandler, _ms?: number, ...args: unknown[]) => {
    if (typeof callback === "function") callback(...args);
    return 5 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          firstBodyCancelled = true;
        },
      });
      return new Response(body, { status: 503 });
    }
    return Response.json({ "job-3": { outputs: { 7: { gifs: [{ filename: "done.webp" }] } } } });
  };

  try {
    const entry = await pollComfyResult("http://comfyui:8188", "job-3", 10_000);
    assert.equal(firstBodyCancelled, true);
    assert.equal(calls, 2);
    assert.ok(entry.outputs);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("ComfyUI cancels a failed output-download response body", async () => {
  const originalFetch = globalThis.fetch;
  let bodyCancelled = false;
  globalThis.fetch = async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
    });
    return new Response(body, { status: 502 });
  };

  try {
    await assert.rejects(
      fetchComfyOutput("http://comfyui:8188", "bad.webp", "", "output"),
      /ComfyUI fetch output failed \(502\)/
    );
    assert.equal(bodyCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ComfyUI stops polling as soon as history reports execution failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let calls = 0;
  globalThis.setTimeout = ((callback: TimerHandler, _ms?: number, ...args: unknown[]) => {
    if (typeof callback === "function") callback(...args);
    return 6 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      "failed-job": {
        outputs: {},
        status: { status_str: "error", completed: false },
      },
    });
  };

  try {
    await assert.rejects(
      pollComfyResult("http://comfyui:8188", "failed-job", 300_000),
      /failed during workflow execution/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("ComfyUI rejects a terminal success that produced no media output", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: TimerHandler, _ms?: number, ...args: unknown[]) => {
    if (typeof callback === "function") callback(...args);
    return 7 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.fetch = async () =>
    Response.json({
      "empty-job": {
        outputs: {},
        status: { status_str: "success", completed: true },
      },
    });

  try {
    await assert.rejects(
      pollComfyResult("http://comfyui:8188", "empty-job", 300_000),
      /completed without media outputs/
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});
