import type {
  DiagnosticOverflowAttempt,
  DiagnosticOverflowAttemptMetadata,
} from "@/lib/usage/diagnosticOverflow";
import { getCurrentDiagnosticOverflowTrace } from "../../utils/providerRequestLogging.ts";
import {
  getLogicalRetryBudget,
  type LogicalRetryBudget,
  isLogicalRetryBudgetError,
  LogicalRetryBudgetError,
} from "../../services/logicalRetryBudget.ts";
type OwnedCapture = {
  attempt: DiagnosticOverflowAttempt;
  signal?: AbortSignal | null;
  budget?: LogicalRetryBudget;
  metadata: DiagnosticOverflowAttemptMetadata;
};
const captures = new WeakMap<Response, OwnedCapture>();

export function getAntigravityDiagnosticCapture(response: Response) {
  return captures.get(response);
}
export function diagnosticDrainEnabled(response: Response) {
  return captures.get(response)?.attempt.acceptingResponse() === true;
}
export function diagnosticErrorSignal(
  response: Response,
  signal?: AbortSignal | null
): AbortSignal {
  const capture = captures.get(response),
    remaining = capture?.budget?.remainingTimeMs();
  const controller = new AbortController();
  if (remaining !== undefined && remaining <= 0)
    controller.abort(
      new LogicalRetryBudgetError("Logical diagnostic error-body deadline exhausted")
    );
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(30000, remaining ?? 30000)));
  return AbortSignal.any([
    controller.signal,
    timeout,
    ...(signal ? [signal] : []),
    ...(capture?.signal ? [capture.signal] : []),
  ]);
}

function captureResponse(response: Response, capture: OwnedCapture): Response {
  let wrapped: ReadableStream<Uint8Array> | null | undefined;
  const proxy = new Proxy(response, {
    get(target, key) {
      if (["text", "json", "arrayBuffer"].includes(String(key)))
        return async () => {
          const body = proxy.body;
          const owned = new Response(body, { headers: target.headers });
          if (key === "text") return owned.text();
          if (key === "json") return owned.json();
          return owned.arrayBuffer();
        };
      if (["clone", "blob", "formData"].includes(String(key)))
        return (...args: unknown[]) => {
          void capture.attempt.fail("unsupported_reader", capture.metadata);
          const method = Reflect.get(target, key, target) as (...values: unknown[]) => unknown;
          return method.apply(target, args);
        };
      if (key !== "body") {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (wrapped !== undefined) return wrapped;
      const original = Reflect.get(target, key, target) as ReadableStream<Uint8Array> | null;
      if (!original) {
        void capture.attempt.finish(capture.metadata);
        wrapped = null;
        return null;
      }
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const ownedReader = () => (reader ??= original.getReader());
      let done = false;
      wrapped = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const item = await ownedReader().read();
              if (done) return;
              if (item.done) {
                done = true;
                await capture.attempt.finish(capture.metadata);
                reader?.releaseLock();
                controller.close();
              } else {
                for (let offset = 0; offset < item.value.byteLength; offset += 65536) {
                  if (done) return;
                  await capture.attempt.writeResponse(item.value.subarray(offset, offset + 65536));
                }
                controller.enqueue(item.value);
              }
            } catch (error) {
              if (!done) {
                done = true;
                await capture.attempt.fail(
                  capture.signal?.aborted ? "abort" : "read_error",
                  capture.metadata
                );
                try {
                  reader?.releaseLock();
                } catch {}
                controller.error(error);
              }
            }
          },
          async cancel(reason) {
            if (done) return;
            done = true;
            try {
              await ownedReader().cancel(reason);
            } finally {
              await capture.attempt.fail(
                capture.signal?.aborted ? "abort" : "cancel",
                capture.metadata
              );
              try {
                reader?.releaseLock();
              } catch {}
            }
          },
        },
        { highWaterMark: 0 }
      );
      return wrapped;
    },
  });
  captures.set(response, capture);
  captures.set(proxy, capture);
  return proxy;
}

/** Each AG send, including region/403/credits retries, owns its exact serialized payload. */
export async function captureAntigravityFetch(
  url: string,
  init: RequestInit,
  serializedBody: string | undefined,
  invoke: () => Promise<Response>
): Promise<Response> {
  const trace = getCurrentDiagnosticOverflowTrace();
  if (!trace || serializedBody === undefined) return invoke();
  const attempt = await trace.beginAttempt({
    requestBody: serializedBody,
    method: init.method || "POST",
    url,
    headers: new Headers(init.headers),
    transport: "http",
  });
  try {
    const response = await invoke();
    return captureResponse(response, {
      attempt,
      signal: init.signal,
      budget: getLogicalRetryBudget(),
      metadata: { status: response.status, headers: response.headers },
    });
  } catch (error) {
    await attempt.fail(
      init.signal?.aborted
        ? "abort"
        : isLogicalRetryBudgetError(error)
          ? "deadline"
          : "upstream_error"
    );
    throw error;
  }
}
