// Pure streaming pass-through helpers for the Antigravity executor (#7408):
// tap an upstream Gemini SSE Response through a credits-extraction
// TransformStream instead of buffering the whole body in the executor, so
// long-thinking models aren't killed by an artificial collection timeout.
// Extracted from antigravity.ts (no host state, no fetch/auth) -- the
// credit-balance cache itself stays in antigravity.ts; callers inject the
// update function below so the two modules don't import each other.

/** Shape of one entry in a Gemini `remainingCredits` SSE payload array. */
export type AntigravityCreditEntry = {
  creditType?: string;
  creditAmount?: string;
};

function asCreditRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Tap complete SSE data lines immediately; bound only incomplete metadata. */
export function createCreditsExtractionTransform(
  accountId: string,
  onCreditsUpdate: (accountId: string, balance: number) => void,
  bufferSize = 0,
  validateCompletion = false
): TransformStream<Uint8Array, Uint8Array> {
  let buffer = "";
  let nativeCandidateSeen = false;
  let completed = false;
  let discardingLine = false;
  const decoder = new TextDecoder();
  const extract = (line: string) => {
    if (!line.trimStart().startsWith("data:")) return;
    const payload = line.trimStart().slice(5).trim();
    if (payload === "[DONE]") {
      completed = true;
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const response = asCreditRecord(parsed.response);
    const candidates = response?.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      nativeCandidateSeen = true;
      if (asCreditRecord(candidates[0])?.finishReason) completed = true;
    }
    const upstreamError = asCreditRecord(parsed.error ?? response?.error);
    if (validateCompletion && upstreamError) {
      const error = new Error("Antigravity upstream stream reported an error") as Error & {
        status: number;
      };
      const code = Number(upstreamError.code);
      error.status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502;
      throw error;
    }
    try {
      const entries = parsed.remainingCredits ?? response?.remainingCredits;
      if (!Array.isArray(entries)) return;
      const credit = entries.find(
        (entry: unknown) => asCreditRecord(entry)?.creditType === "GOOGLE_ONE_AI"
      );
      const balance = Number(credit?.creditAmount);
      if (credit?.creditAmount != null && Number.isFinite(balance) && balance >= 0)
        onCreditsUpdate(accountId, balance);
    } catch {
      // Metadata is optional; malformed lines must not alter the forwarded bytes.
    }
  };
  const consume = (text: string, final = false) => {
    buffer += text;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      if (!discardingLine) extract(buffer.slice(0, newline));
      discardingLine = false;
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (final) {
      if (!discardingLine) extract(buffer);
      buffer = "";
    } else if (buffer.length > (bufferSize > 0 ? bufferSize : 256 * 1024)) {
      buffer = "";
      discardingLine = true;
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>(
    {
      transform(chunk, controller) {
        controller.enqueue(chunk);
        consume(decoder.decode(chunk, { stream: true }));
      },
      flush() {
        consume(decoder.decode(), true);
        if (validateCompletion && nativeCandidateSeen && !completed) {
          throw new Error("Antigravity upstream stream ended before completion");
        }
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 }),
    new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 })
  );
}

/** Result shape returned to callers of AntigravityExecutor.execute(). */
export type SsePassthroughResult = {
  response: Response;
  url: string;
  headers: Record<string, string>;
  transformedBody: unknown;
};

/** Own the reader so abort can free a socket even while a transform write is blocked. */
function abortableBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null
): ReadableStream<Uint8Array> {
  if (!signal) return body;
  const reader = body.getReader();
  let ended = false;
  const cleanup = () => signal.removeEventListener("abort", abort);
  const release = () => {
    try {
      reader.releaseLock();
    } catch {
      /* A read may still be settling. */
    }
  };
  let output: ReadableStreamDefaultController<Uint8Array>;
  const abort = () => {
    if (ended) return;
    ended = true;
    cleanup();
    output.error(signal.reason);
    void reader
      .cancel(signal.reason)
      .catch(() => {})
      .finally(release);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (ended) return;
          if (done) {
            ended = true;
            cleanup();
            release();
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          if (!ended) {
            ended = true;
            cleanup();
            release();
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        ended = true;
        cleanup();
        await reader.cancel(reason).catch(() => {});
        release();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 })
  );
}

/**
 * Build the non-streaming pass-through result: tap `body` through
 * createCreditsExtractionTransform and wrap it in a same-status Response so
 * chatCore's non-streaming path (readNonStreamingResponseBody +
 * parseNonStreamingSSEPayload) can drain and parse the Gemini SSE without
 * this executor buffering the whole stream itself.
 *
 * If the client already disconnected (`signal.aborted`), cancels the
 * upstream body immediately and returns a bare 499 instead of piping a
 * cancelled body through.
 */
export function buildSsePassthroughResult(
  body: ReadableStream<Uint8Array>,
  upstream: { status: number; statusText: string; headers: Headers },
  accountId: string,
  onCreditsUpdate: (accountId: string, balance: number) => void,
  url: string,
  outHeaders: Record<string, string>,
  transformedBody: unknown,
  signal: AbortSignal | null | undefined
): SsePassthroughResult {
  // Client already disconnected — skip pipe
  if (signal?.aborted) {
    body.cancel().catch(() => {});
    return {
      response: new Response(null, { status: 499 }),
      url,
      headers: outHeaders,
      transformedBody: null,
    };
  }
  const tapped = abortableBody(body, signal).pipeThrough(
    createCreditsExtractionTransform(accountId, onCreditsUpdate, 256 * 1024, true),
    signal ? { signal } : undefined
  );
  return {
    response: new Response(tapped, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    }),
    url,
    headers: outHeaders,
    transformedBody,
  };
}
