import test from "node:test";
import assert from "node:assert/strict";

const { handleAudioTranscription } = await import("../../open-sse/handlers/audioTranscription.ts");
const { isAcceptedTaskTimeoutResponse } =
  await import("../../open-sse/services/exhaustedNetworkResponse.ts");

function buildFormData(): FormData {
  const formData = new FormData();
  formData.append("model", "kie/elevenlabs/speech-to-text");
  formData.append("file", new File([Buffer.from("audio")], "clip.wav", { type: "audio/wav" }));
  return formData;
}

test("Kie transcription returns text from every supported result envelope", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      name: "nested response",
      record: { data: { status: "SUCCESS", response: { text: "response text" } } },
      expected: "response text",
    },
    {
      name: "resultText fallback",
      record: {
        data: {
          status: "SUCCESS",
          response: { text: { malformed: true } },
          resultText: "result text",
        },
      },
      expected: "result text",
    },
    {
      name: "nested text fallback",
      record: { data: { status: "SUCCESS", text: "nested text" } },
      expected: "nested text",
    },
    {
      name: "top-level text fallback",
      record: { data: { status: "SUCCESS" }, text: "top-level text" },
      expected: "top-level text",
    },
  ];

  try {
    for (const testCase of cases) {
      const calls: string[] = [];
      globalThis.fetch = async (url, options = {}) => {
        const requestUrl = String(url);
        calls.push(requestUrl);

        if (requestUrl === "https://api.kie.ai/api/v1/jobs/createTask") {
          const payload = JSON.parse(String(options.body));
          assert.equal(payload.model, "elevenlabs/speech-to-text", testCase.name);
          return Response.json({ data: { taskId: "task-1" } });
        }

        assert.equal(
          requestUrl,
          "https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task-1",
          testCase.name
        );
        return Response.json(testCase.record);
      };

      const response = await handleAudioTranscription({
        formData: buildFormData(),
        credentials: { apiKey: "kie-key" },
      });

      assert.equal(response.status, 200, testCase.name);
      assert.deepEqual(await response.json(), { text: testCase.expected }, testCase.name);
      assert.equal(calls.length, 2, testCase.name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepted KIE transcription returns caller cancellation only after polling settles", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const caller = new AbortController();
  let createCalls = 0;
  let pollCalls = 0;
  let pollSignal: AbortSignal | null = null;
  let configuredTimeoutMs = 0;

  // Keep sleeps quick while preserving the real absolute-deadline timer so the
  // handler can clear it as soon as the accepted task settles.
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args) => {
    if (ms === 120_000) {
      configuredTimeoutMs = ms;
      return originalSetTimeout(callback, ms, ...args);
    }
    queueMicrotask(() => callback(...args));
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/api/v1/jobs/createTask")) {
      createCalls += 1;
      return Response.json({ data: { taskId: "accepted-task" } });
    }

    pollCalls += 1;
    const signal = options.signal as AbortSignal;
    if (!pollSignal) pollSignal = signal;
    assert.equal(signal, pollSignal, "all poll attempts share one absolute deadline");
    assert.notEqual(signal, caller.signal, "caller disconnect must not cancel accepted work");
    assert.equal(signal.aborted, false, "caller disconnect does not abort the server deadline");
    if (pollCalls === 1) {
      caller.abort();
      return Response.json({ data: { status: "PENDING" } });
    }
    return Response.json({ data: { status: "SUCCESS", response: { text: "completed" } } });
  };

  try {
    const response = await handleAudioTranscription({
      formData: buildFormData(),
      credentials: { apiKey: "kie-key" },
      signal: caller.signal,
    });

    assert.equal(response.status, 499);
    assert.equal(configuredTimeoutMs, 120_000);
    assert.equal(createCalls, 1, "the accepted task must not be resubmitted");
    assert.equal(pollCalls, 2, "continue polling after abort until the task is terminal");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("accepted KIE transcription's absolute deadline interrupts a hanging status fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let configuredTimeoutMs = 0;
  let pollCalls = 0;
  let fireDeadline: (() => void) | null = null;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args) => {
    if (ms === 120_000) {
      configuredTimeoutMs = ms;
      fireDeadline = () => callback(...args);
      // Return a real timer handle; the handler must clear it after polling
      // exits, and this inert callback is only a backstop if the test fails.
      return originalSetTimeout(() => {}, ms, ...args);
    }
    return originalSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/api/v1/jobs/createTask")) {
      return Response.json({ data: { taskId: "accepted-task" } });
    }

    pollCalls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = options.signal as AbortSignal;
      assert.ok(signal, "the status request must have a server-side deadline signal");
      const rejectOnAbort = () => reject(signal.reason);
      signal.addEventListener("abort", rejectOnAbort, { once: true });
      if (signal.aborted) rejectOnAbort();
      assert.ok(fireDeadline, "the absolute deadline timer must be armed before polling");
      fireDeadline();
    });
  };

  try {
    const response = await handleAudioTranscription({
      formData: buildFormData(),
      credentials: { apiKey: "kie-key" },
    });

    assert.equal(configuredTimeoutMs, 120_000);
    assert.equal(
      pollCalls,
      1,
      "the active poll is interrupted instead of hanging past its deadline"
    );
    assert.equal(response.status, 504);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("KIE createTask is bounded by a server deadline without using the caller signal", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const caller = new AbortController();
  let createCalls = 0;
  let fireDeadline: (() => void) | null = null;

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args) => {
    if (ms === 120_000) {
      fireDeadline = () => callback(...args);
      return originalSetTimeout(() => {}, ms, ...args);
    }
    return originalSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  globalThis.fetch = async (_url, options = {}) => {
    createCalls += 1;
    const signal = options.signal as AbortSignal;
    assert.ok(signal, "KIE createTask must receive a server-owned deadline");
    assert.notEqual(signal, caller.signal, "caller abort cannot cancel an ambiguous createTask");
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
      if (!fireDeadline) throw new Error("KIE createTask deadline was not armed");
      fireDeadline();
    });
  };

  try {
    const response = await handleAudioTranscription({
      formData: buildFormData(),
      credentials: { apiKey: "kie-key" },
      signal: caller.signal,
    });

    assert.equal(response.status, 504);
    assert.equal(isAcceptedTaskTimeoutResponse(response), true);
    assert.equal(createCalls, 1, "an ambiguous createTask request is never replayed");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});
