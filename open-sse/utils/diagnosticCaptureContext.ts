import { AsyncLocalStorage } from "node:async_hooks";
import type { DiagnosticOverflowTrace } from "@/lib/usage/diagnosticOverflow";
const key = Symbol.for("omniroute.diagnosticCaptureContext.v1");
const runtime = globalThis as typeof globalThis & {
  [key]?: {
    originals: WeakMap<object, string>;
    context: AsyncLocalStorage<Set<DiagnosticOverflowTrace>>;
  };
};
const shared = (runtime[key] ??= {
  originals: new WeakMap<object, string>(),
  context: new AsyncLocalStorage<Set<DiagnosticOverflowTrace>>(),
});
const { originals, context } = shared;

/** Private parsed-and-reserialized JSON, captured before request translation mutates it. */
export function recordDiagnosticClientJson(envelope: object, body: unknown, eligible: boolean) {
  if (!eligible || process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED !== "true") return;
  try {
    const json = JSON.stringify(body);
    if (typeof json === "string") originals.set(envelope, json);
  } catch {}
}
export function inheritDiagnosticClientJson(original: object, copy: object) {
  const json = originals.get(original);
  if (json !== undefined) originals.set(copy, json);
}
export function getDiagnosticClientJson(envelope: unknown): string | undefined {
  return envelope && typeof envelope === "object" ? originals.get(envelope) : undefined;
}
export function registerDiagnosticTrace(trace: DiagnosticOverflowTrace | null) {
  if (trace) context.getStore()?.add(trace);
}
async function close(traces: Set<DiagnosticOverflowTrace>, reason?: string) {
  await Promise.all([...traces].map((trace) => (reason ? trace.abort(reason) : trace.finish())));
}

/** One Core provider leg owns its trace through final client body EOF/cancel/error. */
export async function runWithDiagnosticCaptureLifecycle<T>(invoke: () => Promise<T>): Promise<T> {
  if (process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED !== "true") return invoke();
  const traces = new Set<DiagnosticOverflowTrace>();
  return context.run(traces, async () => {
    try {
      const result = await invoke();
      if (!traces.size) return result;
      const record =
        result && typeof result === "object" ? (result as Record<string, unknown>) : null;
      const response = result instanceof Response ? result : record?.response;
      if (!(response instanceof Response) || !response.body) {
        await close(traces);
        return result;
      }
      const reader = response.body.getReader();
      let ended = false;
      const finish = async (reason?: string) => {
        if (ended) return;
        ended = true;
        await close(traces, reason);
      };
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const item = await reader.read();
              if (item.done) {
                await finish();
                reader.releaseLock();
                controller.close();
              } else controller.enqueue(item.value);
            } catch (error) {
              await finish("read_error");
              try {
                reader.releaseLock();
              } catch {}
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              await finish("abort");
              try {
                reader.releaseLock();
              } catch {}
            }
          },
        },
        { highWaterMark: 0 }
      );
      const wrapped = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      for (const key of Object.getOwnPropertySymbols(response)) {
        if (!Symbol.keyFor(key)?.startsWith("omniroute.")) continue;
        const descriptor = Object.getOwnPropertyDescriptor(response, key);
        if (descriptor) Object.defineProperty(wrapped, key, descriptor);
      }
      return (result instanceof Response ? wrapped : { ...record, response: wrapped }) as T;
    } catch (error) {
      await close(traces, "abort");
      throw error;
    }
  });
}
