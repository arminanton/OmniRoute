interface GenerationLifetimes {
  active: number;
  observed: Set<string>;
  unknown: boolean;
}
declare global {
  var __omniGenerationLifetimes: GenerationLifetimes | undefined;
}
const state = (globalThis.__omniGenerationLifetimes ??= {
  active: 0,
  observed: new Set<string>(),
  unknown: false,
});
/** Count a real generation send until its body/terminal event ends. Idempotent close. */
export function beginGenerationLifetime(transport = "explicit"): () => void {
  state.observed.add(transport);
  state.active++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    state.active = Math.max(0, state.active - 1);
  };
}
/** Null means no actual generation boundary has been observed, or a bypass was identified. */
export function getPhysicalGenerationCount(): number | null {
  return state.unknown || !state.observed.size ? null : state.active;
}
export function markUntrackedGenerationLifetime(): void {
  state.unknown = true;
}
export function getGenerationLifetimeCoverage() {
  return { transports: [...state.observed].sort(), unknown: state.unknown };
}

/** Do not touch a native error body's getter. Successful bodies are owned until EOF/error/cancel. */
export function bindGenerationResponse(
  response: Response,
  finish: () => void,
  observation?: {
    chunk: (bytes: Uint8Array) => void;
    close: (reason: "eof" | "cancel" | "error" | "no_body") => void;
  }
): Response {
  if (!response.ok) {
    observation?.close("no_body");
    finish();
    return response;
  }
  let body: ReadableStream<Uint8Array> | null;
  try {
    body = response.body;
  } catch (error) {
    observation?.close("error");
    finish();
    throw error;
  }
  if (!body) {
    observation?.close("no_body");
    finish();
    return response;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch (error) {
    observation?.close("error");
    finish();
    throw error;
  }
  let ended = false;
  const close = () => {
    if (ended) return;
    ended = true;
    finish();
    try {
      reader.releaseLock();
    } catch {
      /* Read/cancel may be settling. */
    }
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (ended) return;
          if (next.done) {
            observation?.close("eof");
            close();
            controller.close();
          } else {
            observation?.chunk(next.value);
            controller.enqueue(next.value);
          }
        } catch (error) {
          if (!ended) {
            observation?.close("error");
            close();
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        if (ended) return;
        try {
          await reader.cancel(reason);
        } finally {
          observation?.close("cancel");
          close();
        }
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 16384 })
  );
  const wrapped = new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const property of ["url", "redirected", "type"] as const)
    Object.defineProperty(wrapped, property, { value: response[property] });
  return wrapped;
}

/** Undici and native/TLS implementations need not share the global Response constructor. */
export function isGenerationFetchResponse(value: unknown): value is Response {
  if (!value || typeof value !== "object") return false;
  const response = value as { status?: unknown; ok?: unknown; headers?: { get?: unknown } };
  return (
    typeof response.status === "number" &&
    typeof response.ok === "boolean" &&
    typeof response.headers?.get === "function"
  );
}
