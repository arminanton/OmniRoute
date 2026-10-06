import assert from "node:assert/strict";
import test from "node:test";
import type { Dispatcher } from "undici";
import { withProviderResponseStartDeadline } from "../../open-sse/utils/providerResponseStartDeadline.ts";
import {
  getObservedResponseStartTimeoutMs,
  observeFetchDispatcher,
} from "../../open-sse/utils/fetchDispatchObserver.ts";

test("transport queue time does not consume the executor's headers budget", async () => {
  const value = await withProviderResponseStartDeadline(
    200,
    null,
    async (signal) => {
      assert.equal(getObservedResponseStartTimeoutMs(), 200);
      return new Promise<string>((resolve, reject) => {
        const timers: ReturnType<typeof setTimeout>[] = [];
        const abort = () => {
          timers.forEach(clearTimeout);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        const dispatcher = observeFetchDispatcher({
          dispatch(_options: unknown, handler: Dispatcher.DispatchHandler) {
            timers.push(
              setTimeout(() => {
                handler.onRequestStart?.(null);
                timers.push(
                  setTimeout(() => {
                    signal?.removeEventListener("abort", abort);
                    resolve("accepted after queue and headers");
                  }, 150)
                );
              }, 150)
            );
            return true;
          },
        } as unknown as Dispatcher);
        dispatcher.dispatch(
          { origin: "https://synthetic.invalid", path: "/responses", method: "POST" },
          {}
        );
      });
    },
    () => new Error("headers deadline exceeded"),
    500
  );
  assert.equal(value, "accepted after queue and headers");
  assert.equal(getObservedResponseStartTimeoutMs(), null);
});

test("caller cancellation remains authoritative and ownership clears after failure", async () => {
  const abort = new AbortController();
  const reason = new Error("caller ended turn");
  await assert.rejects(
    withProviderResponseStartDeadline(
      100,
      abort.signal,
      async (signal) => {
        abort.abort(reason);
        throw signal?.reason;
      },
      () => new Error("headers deadline exceeded")
    ),
    (error) => error === reason
  );
  assert.equal(getObservedResponseStartTimeoutMs(), null);
});

test("independent concurrent requests cannot inherit another executor's budget", async () => {
  await Promise.all(
    [100, 200, 300].map((budget) =>
      withProviderResponseStartDeadline(
        budget,
        null,
        async () => {
          await new Promise<void>((r) => setTimeout(r, 5));
          assert.equal(getObservedResponseStartTimeoutMs(), budget);
        },
        () => new Error("headers deadline exceeded")
      )
    )
  );
});
