type JsonRecord = Record<string, unknown>;
const FRAME_LIMIT = 64 * 1024;
const record = (value: unknown): JsonRecord | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;

/** Inspect protocol envelopes only; generated text mentioning errors is ordinary output. */
function protocolFailure(
  value: unknown,
  eventName = ""
): { status: number; message: string } | null {
  const frame = record(value);
  if (!frame) return null;
  const response = record(frame.response);
  const error = record(frame.error) ?? record(response?.error);
  const failed =
    ["error", "response.failed", "response.incomplete"].includes(eventName) ||
    frame.type === "error" ||
    frame.type === "response.failed" ||
    frame.type === "response.incomplete" ||
    response?.status === "failed" ||
    response?.status === "incomplete";
  if (!error && !failed) return null;
  const rawStatus =
    error?.code ?? error?.status ?? frame.status ?? (failed ? frame.code : undefined);
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : 0;
  return {
    status,
    message:
      typeof error?.message === "string"
        ? error.message.slice(0, 4096)
        : failed && typeof frame.message === "string"
          ? frame.message.slice(0, 4096)
          : "",
  };
}

function knownCompletion(value: unknown): boolean {
  const frame = record(value);
  if (!frame) return false;
  const response = record(frame.response) ?? frame;
  if (
    frame.type === "response.completed" ||
    (response.object === "response" && response.status === "completed") ||
    frame.type === "message_stop"
  )
    return true;
  if (
    frame.type === "message" &&
    ["end_turn", "tool_use", "max_tokens", "stop_sequence"].includes(String(frame.stop_reason))
  )
    return true;
  const choices = Array.isArray(frame.choices) ? frame.choices : [];
  if (
    choices.some((choice) =>
      ["stop", "length", "tool_calls", "function_call"].includes(
        String(record(choice)?.finish_reason)
      )
    )
  )
    return true;
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  return candidates.some((candidate) =>
    ["STOP", "MAX_TOKENS"].includes(String(record(candidate)?.finishReason))
  );
}

export class AdmissionResponseOutcome {
  private decoder = new TextDecoder();
  private pending = "";
  private eventData: string[] = [];
  private eventLength = 0;
  private eventName = "";
  private failed = false;
  private unknown = false;
  private observed = false;
  constructor(
    private readonly onFailure?: (failure: { status: number; message: string }) => void
  ) {}
  private parse(data: string) {
    if (["error", "response.failed", "response.incomplete"].includes(this.eventName))
      this.failed = true;
    if (!data || data === "[DONE]") return;
    try {
      const value: unknown = JSON.parse(data);
      if (!record(value)) {
        this.unknown = true;
        return;
      }
      this.observed ||= knownCompletion(value);
      const failure = protocolFailure(value, this.eventName);
      if (failure) {
        this.failed = true;
        try {
          this.onFailure?.(failure);
        } catch {
          this.unknown = true;
        }
      }
    } catch {
      this.unknown = true;
    }
  }
  private line(line: string) {
    if (!line) {
      this.parse(this.eventData.join("\n"));
      this.eventData = [];
      this.eventLength = 0;
      this.eventName = "";
      return;
    }
    if (line.startsWith("event:")) this.eventName = line.slice(6).trim().slice(0, 64);
    if (line.startsWith("data:")) {
      const data = line.slice(5).trimStart();
      if (this.eventLength + data.length > FRAME_LIMIT) {
        this.unknown = true;
        this.eventData = [];
        this.eventLength = 0;
        return;
      }
      this.eventData.push(data);
      this.eventLength += data.length;
    }
  }
  push(chunk: Uint8Array) {
    const text = this.decoder.decode(chunk, { stream: true });
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const segment = lines[index];
      // Do not retain a giant token delta merely to classify feedback. Oversize is unknown.
      if (this.pending.length + segment.length > FRAME_LIMIT) {
        this.unknown = true;
        this.pending = "";
        continue;
      }
      this.pending += segment;
      if (index < lines.length - 1) {
        this.line(this.pending.replace(/\r$/, ""));
        this.pending = "";
      }
    }
  }
  finish() {
    const tail = this.decoder.decode();
    if (tail) this.pending += tail;
    if (this.pending) this.line(this.pending.replace(/\r$/, ""));
    this.pending = "";
    this.line("");
  }
  healthy() {
    return this.observed && !this.failed && !this.unknown;
  }
}

/** Non-disruptive, bounded metadata observer: every byte forwards unchanged. */
export function observeAdmissionStream(
  body: ReadableStream<Uint8Array>,
  onFailure?: (failure: { status: number; message: string }) => void
) {
  const outcome = new AdmissionResponseOutcome(onFailure);
  const observed = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        outcome.push(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        outcome.finish();
      },
    })
  );
  return { body: observed, healthy: () => outcome.healthy() };
}

export function isHealthyAdmissionPayload(payload: string, contentType: string): boolean {
  if (contentType.includes("text/event-stream")) {
    const outcome = new AdmissionResponseOutcome();
    outcome.push(new TextEncoder().encode(payload));
    outcome.finish();
    return outcome.healthy();
  }
  if (payload.length > FRAME_LIMIT) return false;
  try {
    const value: unknown = JSON.parse(payload);
    return knownCompletion(value) && !protocolFailure(value);
  } catch {
    return false;
  }
}
