import type {
  DiagnosticOverflowAttempt,
  DiagnosticOverflowTrace,
} from "@/lib/usage/diagnosticOverflow";
import { AsyncLocalStorage } from "node:async_hooks";

import { updatePendingScope, type PendingRequestScope } from "@/lib/usage/pendingRequestScope";

export type ProviderRequestPrepared = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  bodyString: string;
};

export type Capture = {
  /** Skip observing serialized provider bodies when detailed request logging is disabled. */
  enabled?: boolean;
  /** Full wire payload is persisted by the private trace; avoid parsing a duplicate log object. */
  diagnosticOverflowOnly?: boolean;
  diagnosticTrace?: DiagnosticOverflowTrace | null;
  diagnosticProvider?: string;
  capture: (request: ProviderRequestPrepared) => Promise<void> | void;
  attempt?: (diagnostic: Record<string, unknown>) => void;
  body: (fallback: unknown) => unknown;
  latest?: () => ProviderRequestPrepared | null;
  /** Drop any retained prepared request after its terminal log has been written. */
  release?: () => void;
};

type RequestLoggerLike = {
  getDiagnosticOverflowTrace?: () => DiagnosticOverflowTrace | null;
  diagnosticOverflowOnly?: boolean;
  logTargetRequest: (url: unknown, headers: Record<string, string>, body: unknown) => void;
  logProviderAttempt?: (diagnostic: Record<string, unknown>) => void;
};

type WarnLog = {
  warn?: (tag: string, message: string) => void;
};

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

type CaptureState = {
  context: AsyncLocalStorage<Capture>;
  wrappedFetch: typeof fetch | null;
  wrappedInnerFetch: typeof fetch | null;
};

const CAPTURE_STATE_KEY = Symbol.for("omniroute.providerRequestCapture.state");

function getCaptureState(): CaptureState {
  const scopedGlobal = globalThis as typeof globalThis & {
    [CAPTURE_STATE_KEY]?: CaptureState;
  };

  if (!scopedGlobal[CAPTURE_STATE_KEY]) {
    scopedGlobal[CAPTURE_STATE_KEY] = {
      context: new AsyncLocalStorage<Capture>(),
      wrappedFetch: null,
      wrappedInnerFetch: null,
    };
  }
  return scopedGlobal[CAPTURE_STATE_KEY];
}

const captureState = getCaptureState();
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const AUTH_BODY_KEYS = new Set([
  "access_token",
  "client_secret",
  "grant_type",
  "id_token",
  "refresh_token",
]);
const REQUEST_BODY_KEYS = new Set([
  "conversationId",
  "conversation_id",
  "contents",
  "input",
  "messages",
  "model",
  "prompt",
  "request",
  "tools",
  "userSelectedModel",
]);

export function parseBody(bodyString: string): unknown {
  try {
    return JSON.parse(bodyString);
  } catch {
    return bodyString;
  }
}

async function capturePreparedRequest(
  requestCapture: Capture | null | undefined,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  bodyString: string,
  log?: WarnLog | null
) {
  if (!requestCapture || requestCapture.enabled === false) return;
  const latest = requestCapture.latest?.();
  if (latest?.url === url && latest.bodyString === bodyString) return;

  try {
    await requestCapture.capture({ url, headers, body, bodyString });
  } catch (error) {
    log?.warn?.(
      "REQUEST_LOG",
      `Provider request logging hook failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function captureCurrentProviderRequest(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  bodyString: string,
  log?: WarnLog | null
) {
  return capturePreparedRequest(
    captureState.context.getStore(),
    url,
    headers,
    body,
    bodyString,
    log
  );
}

export function captureCurrentProviderBody(
  url: string,
  headers: Record<string, string>,
  bodyString: string,
  log?: WarnLog | null
) {
  const requestCapture = captureState.context.getStore();
  if (requestCapture?.diagnosticOverflowOnly) {
    return capturePreparedRequest(requestCapture, url, headers, null, "private-overflow", log);
  }
  return captureCurrentProviderRequest(url, headers, parseBody(bodyString), bodyString, log);
}

/** Record one pre-projected provider failure without retaining the raw response. */
export function captureCurrentProviderAttempt(diagnostic: Record<string, unknown>) {
  const activeCapture = captureState.context.getStore();
  if (!activeCapture || activeCapture.enabled === false || !activeCapture.attempt) return;
  try {
    activeCapture.attempt(diagnostic);
  } catch {
    // Failure evidence is best-effort and cannot change provider execution.
  }
}

export function runWithCapture<T>(requestCapture: Capture, fn: () => Promise<T>): Promise<T> {
  if (requestCapture.enabled === false) return fn();
  installFetchCapture();
  return captureState.context.run(requestCapture, fn);
}

function installFetchCapture() {
  if (globalThis.fetch === captureState.wrappedFetch) return;

  captureState.wrappedInnerFetch = globalThis.fetch.bind(globalThis);
  captureState.wrappedFetch = (async (input: FetchInput, init?: FetchInit) => {
    const activeCapture = captureState.context.getStore();
    const codexAttempt = activeCapture
      ? await captureFetchRequest(activeCapture, input, init)
      : null;
    try {
      const response = await captureState.wrappedInnerFetch!(input, init);
      return codexAttempt && codexAttempt.acceptingResponse()
        ? captureDiagnosticResponse(response, codexAttempt, init?.signal)
        : response;
    } catch (error) {
      if (codexAttempt) {
        const reason = init?.signal?.aborted
          ? "abort"
          : error instanceof Error && error.name === "TimeoutError"
            ? "timeout"
            : "upstream_error";
        void codexAttempt.fail(reason);
      }
      throw error;
    }
  }) as typeof fetch;
  globalThis.fetch = captureState.wrappedFetch;
}

async function captureFetchRequest(
  requestCapture: Capture,
  input: FetchInput,
  init?: FetchInit
): Promise<DiagnosticOverflowAttempt | null> {
  const method = getFetchMethod(input, init);
  if (!BODY_METHODS.has(method)) return null;

  const bodyString = bodyToString(init?.body);
  if (!bodyString) return null;

  const body = parseBody(bodyString);
  if (!looksLikeProviderRequestBody(body)) return null;

  const url = getFetchUrl(input);
  const headers = getFetchHeaders(input, init);
  await capturePreparedRequest(requestCapture, url, headers, body, bodyString);

  const trace = requestCapture.diagnosticTrace;
  if (!trace || !isCodexProvider(requestCapture.diagnosticProvider)) return null;
  return trace.beginAttempt({
    requestBody: bodyString,
    method,
    url,
    headers,
    transport: "http",
  });
}

function isCodexProvider(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "codex" || normalized === "openai-codex";
}

function captureDiagnosticResponse(
  response: Response,
  attempt: DiagnosticOverflowAttempt,
  signal?: AbortSignal | null
): Response {
  let wrapped: ReadableStream<Uint8Array> | null | undefined;
  const metadata = { status: response.status, headers: response.headers };
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
          void attempt.fail("unsupported_reader", metadata);
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
        void attempt.finish(metadata);
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
                void attempt.finish(metadata);
                reader?.releaseLock();
                controller.close();
              } else {
                const drainLargeSourceChunk = item.value.byteLength > 256 * 1024;
                // Keep ordinary provider/client streaming independent of local disk
                // I/O. The writer has a bounded queue and marks overflow incomplete. A
                // single unusually large source chunk is drained in 64 KiB pieces
                // so it cannot overflow the capture queue before its first write.
                for (let offset = 0; offset < item.value.byteLength; offset += 65536) {
                  const pending = attempt.writeResponse(
                    item.value.subarray(offset, offset + 65536)
                  );
                  if (drainLargeSourceChunk) await pending;
                  else void pending;
                }
                controller.enqueue(item.value);
              }
            } catch (error) {
              if (!done) {
                done = true;
                void attempt.fail(signal?.aborted ? "abort" : "read_error", metadata);
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
              void attempt.fail(signal?.aborted ? "abort" : "cancel", metadata);
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
  return proxy;
}

function getFetchMethod(input: FetchInput, init?: FetchInit) {
  const method = init?.method || (isRequest(input) ? input.method : "GET");
  return String(method || "GET").toUpperCase();
}

function getFetchUrl(input: FetchInput) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (isRequest(input)) return input.url;
  return String(input);
}

function getFetchHeaders(input: FetchInput, init?: FetchInit) {
  const headers = new Headers(isRequest(input) ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function bodyToString(body: BodyInit | null | undefined): string | null {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    );
  }
  return null;
}

function isRequest(input: FetchInput): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

function looksLikeProviderRequestBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;

  if (Object.keys(record).some((key) => AUTH_BODY_KEYS.has(key))) return false;
  if (Object.keys(record).some((key) => REQUEST_BODY_KEYS.has(key))) return true;

  return (
    typeof record.query === "string" && !!record.variables && typeof record.variables === "object"
  );
}

export function createPreparedRequestLogger(
  reqLogger: RequestLoggerLike,
  scope: PendingRequestScope,
  options: { enabled?: boolean; provider?: string } = {}
): Capture {
  let latest: ProviderRequestPrepared | null = null;
  const enabled = options.enabled !== false;
  const diagnosticOverflowOnly = reqLogger.diagnosticOverflowOnly === true;
  return {
    enabled,
    diagnosticOverflowOnly,
    diagnosticTrace: enabled ? reqLogger.getDiagnosticOverflowTrace?.() : null,
    diagnosticProvider: options.provider,
    attempt(diagnostic) {
      if (!enabled) return;
      reqLogger.logProviderAttempt?.(diagnostic);
    },
    capture(request) {
      if (!enabled) return;
      latest = request;
      if (diagnosticOverflowOnly) {
        reqLogger.logTargetRequest(request.url, request.headers, null);
        updatePendingScope(scope, {
          providerUrl: request.url,
          stage: "sending_to_provider",
        });
      } else {
        reqLogger.logTargetRequest(request.url, request.headers, request.body);
        updatePendingScope(scope, {
          providerRequest: request.body,
          providerUrl: request.url,
          stage: "sending_to_provider",
        });
      }
    },
    body(fallback) {
      if (!enabled) return fallback;
      if (diagnosticOverflowOnly) return fallback;
      const resolved = latest?.body ?? fallback;
      // #4091: the captured body is rebuilt from the serialized upstream payload
      // (the fetch-capture does `JSON.parse(JSON.stringify(...))`), which drops
      // non-enumerable properties. The native-Claude tool-name cloak stashes its
      // per-request alias→original map as a NON-ENUMERABLE `_toolNameMap` on the
      // real (fallback) transformed body; without it the response-side un-cloak
      // (`mergeResponseToolNameMap` → `remapToolNamesInResponse`) can't restore
      // MCP / snake_case tool names, so Claude Code receives the cloaked
      // PascalCase name and rejects every call with "No such tool available".
      // Re-attach the map onto the resolved (captured) body — kept non-enumerable
      // so it still never re-serializes into an upstream request.
      if (
        resolved !== fallback &&
        resolved &&
        typeof resolved === "object" &&
        fallback &&
        typeof fallback === "object"
      ) {
        const map = (fallback as Record<string, unknown>)._toolNameMap;
        const target = resolved as Record<string, unknown>;
        if (map instanceof Map && !(target._toolNameMap instanceof Map)) {
          Object.defineProperty(target, "_toolNameMap", {
            value: map,
            enumerable: false,
            configurable: true,
            writable: true,
          });
        }
      }
      return resolved;
    },
    latest() {
      return latest;
    },
    release() {
      latest = null;
    },
  };
}

export function getCurrentDiagnosticOverflowTrace(): DiagnosticOverflowTrace | null {
  return captureState.context.getStore()?.diagnosticTrace ?? null;
}
