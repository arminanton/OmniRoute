import test from "node:test";
import assert from "node:assert/strict";
import {
  ComfyWorkflowSubmitError,
  fetchComfyOutput,
  submitComfyWorkflow,
} from "../../open-sse/utils/comfyuiClient.ts";

test("ComfyUI rejects a pre-aborted submit without contacting the server", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ prompt_id: "unexpected" }), { status: 200 });
  };

  try {
    controller.abort();
    await assert.rejects(submitComfyWorkflow("http://comfyui:8188", {}, controller.signal));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ComfyUI submit stays observable after dispatch and artifact fetch accepts a signal", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let releaseSubmit!: (response: Response) => void;
  let submitStarted!: () => void;
  let outputSignal: AbortSignal | undefined;
  const submitGate = new Promise<Response>((resolve) => (releaseSubmit = resolve));
  const started = new Promise<void>((resolve) => (submitStarted = resolve));

  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/prompt")) {
      assert.equal(init?.signal, undefined);
      submitStarted();
      return submitGate;
    }
    outputSignal = init?.signal as AbortSignal | undefined;
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };

  try {
    const submit = submitComfyWorkflow("http://comfyui:8188", {}, controller.signal);
    await started;
    controller.abort();
    releaseSubmit(
      new Response(JSON.stringify({ prompt_id: "job-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    assert.equal(await submit, "job-1");

    await fetchComfyOutput("http://comfyui:8188", "out.png", "", "output", controller.signal);
    assert.equal(outputSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ComfyUI marks an ambiguous submit response terminal but treats explicit rejection as nonterminal", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => {
      throw new TypeError("socket closed after submit");
    };
    await assert.rejects(submitComfyWorkflow("http://comfyui:8188", {}), (error: unknown) => {
      assert.ok(error instanceof ComfyWorkflowSubmitError);
      assert.equal(error.terminal, true);
      return true;
    });

    globalThis.fetch = async () => new Response("forbidden", { status: 403 });
    await assert.rejects(submitComfyWorkflow("http://comfyui:8188", {}), (error: unknown) => {
      assert.ok(error instanceof ComfyWorkflowSubmitError);
      assert.equal(error.terminal, false);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
