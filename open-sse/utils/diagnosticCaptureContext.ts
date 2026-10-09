import { AsyncLocalStorage } from "node:async_hooks";
import type { DiagnosticOverflowTrace } from "@/lib/usage/diagnosticOverflow";
import { estimateSizeFast } from "./estimateSize.ts";
const key = Symbol.for("omniroute.diagnosticCaptureContext.v1");
type ClientCaptureSnapshot = { body?: unknown; json?: string; bytes?: Uint8Array };
const runtime = globalThis as typeof globalThis & {
  [key]?: {
    originals: WeakMap<object, ClientCaptureSnapshot>;
    context: AsyncLocalStorage<Set<DiagnosticOverflowTrace>>;
  };
};
const shared = (runtime[key] ??= {
  originals: new WeakMap<object, ClientCaptureSnapshot>(),
  context: new AsyncLocalStorage<Set<DiagnosticOverflowTrace>>(),
});
const { originals, context } = shared;

const MAX_CLIENT_SNAPSHOT_VALUES = 500_000;
const MAX_CLIENT_SNAPSHOT_DEPTH = 64;
// Keep the synthetic 3.5 MB high-context agent request on the private-trace path
// when overflow capture is explicitly enabled; ordinary call-log preparation
// conservatively reserves more than the 128 MiB aggregate budget under fan-out.
const DEFAULT_MIN_CLIENT_BYTES = 3_000_000;

function getMinimumClientBytes(): number {
  const configured = process.env.OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES;
  if (configured === undefined) return DEFAULT_MIN_CLIENT_BYTES;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_CLIENT_BYTES;
}

/** Clone JSON structure while sharing immutable string/primitive values. */
function snapshotJsonBody(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  let values = 0;
  const visit = (current: unknown, depth: number): unknown => {
    if (++values > MAX_CLIENT_SNAPSHOT_VALUES || depth > MAX_CLIENT_SNAPSHOT_DEPTH) {
      throw new Error("diagnostic_client_snapshot_limit");
    }
    if (!current || typeof current !== "object") return current;
    const objectValue = current as object;
    if (ancestors.has(objectValue)) throw new Error("diagnostic_client_snapshot_cycle");
    ancestors.add(objectValue);
    try {
      if (Array.isArray(current)) {
        const result = new Array(current.length);
        for (let index = 0; index < current.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor) continue;
          if (!("value" in descriptor)) throw new Error("diagnostic_client_snapshot_accessor");
          result[index] = visit(descriptor.value, depth + 1);
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("diagnostic_client_snapshot_prototype");
      }
      const result: Record<string, unknown> = {};
      for (const property of Object.keys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, property);
        if (!descriptor || !("value" in descriptor)) {
          throw new Error("diagnostic_client_snapshot_accessor");
        }
        result[property] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(objectValue);
    }
  };
  return visit(value, 0);
}

/** Snapshot only large client requests; ordinary AG requests use bounded call artifacts. */
export function recordDiagnosticClientJson(envelope: object, body: unknown, eligible: boolean) {
  if (!eligible || process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED !== "true") return;
  const minClientBytes = getMinimumClientBytes();
  if (minClientBytes > 0 && estimateSizeFast(body, minClientBytes) <= minClientBytes) return;
  try {
    originals.set(envelope, { body: snapshotJsonBody(body) });
  } catch {
    // Diagnostic capture is best-effort and must never block request routing.
  }
}
/** Retain the admitted immutable bytes so diagnostics can write them directly
 * instead of cloning the parsed JSON tree and serializing another full-size string.
 */
export function recordDiagnosticClientBytes(
  envelope: object,
  bytes: Uint8Array | undefined,
  eligible: boolean
) {
  if (!eligible || !bytes || process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED !== "true") return;
  const minClientBytes = getMinimumClientBytes();
  if (minClientBytes > 0 && bytes.byteLength <= minClientBytes) return;
  originals.set(envelope, { bytes });
}
export function hasDiagnosticClientJson(envelope: unknown): boolean {
  return !!envelope && typeof envelope === "object" && originals.has(envelope);
}
export function inheritDiagnosticClientJson(original: object, copy: object) {
  const snapshot = originals.get(original);
  if (snapshot !== undefined) originals.set(copy, snapshot);
}
export function getDiagnosticClientJson(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const snapshot = originals.get(envelope);
  if (!snapshot) return undefined;
  if (snapshot.json !== undefined) return snapshot.json;
  try {
    const json = JSON.stringify(snapshot.body);
    if (typeof json !== "string") return undefined;
    snapshot.json = json;
    snapshot.body = undefined;
    return json;
  } catch {
    snapshot.body = undefined;
    return undefined;
  }
}
export function getDiagnosticClientBody(envelope: unknown): string | Uint8Array | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const snapshot = originals.get(envelope);
  if (!snapshot) return undefined;
  if (snapshot.bytes !== undefined) {
    const bytes = snapshot.bytes;
    snapshot.bytes = undefined;
    return bytes;
  }
  return getDiagnosticClientJson(envelope);
}
export function releaseDiagnosticClientJson(envelope: unknown) {
  if (!envelope || typeof envelope !== "object") return;
  const snapshot = originals.get(envelope);
  if (snapshot) {
    snapshot.body = undefined;
    snapshot.json = undefined;
    snapshot.bytes = undefined;
  }
  originals.delete(envelope);
}
export function registerDiagnosticTrace(trace: DiagnosticOverflowTrace | null) {
  if (trace) context.getStore()?.add(trace);
}
async function close(traces: Set<DiagnosticOverflowTrace>, reason?: string) {
  await Promise.all([...traces].map((trace) => (reason ? trace.abort(reason) : trace.finish())));
}

function closeInBackground(traces: Set<DiagnosticOverflowTrace>, reason?: string): void {
  void close(traces, reason).catch(() => {
    // Diagnostic finalization is best-effort and cannot hold an API response open.
  });
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
        closeInBackground(traces);
        return result;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const item = await reader.read();
              if (item.done) {
                closeInBackground(traces);
                reader.releaseLock();
                controller.close();
              } else controller.enqueue(item.value);
            } catch (error) {
              closeInBackground(traces, "read_error");
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
              closeInBackground(traces, "abort");
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
      closeInBackground(traces, "abort");
      throw error;
    }
  });
}
