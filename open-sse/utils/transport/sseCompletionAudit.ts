/** Bounded application completion proof catches EOF that an H2 dependency reports as clean. */
export class SseCompletionAudit {
  private decoder = new TextDecoder();
  private pending = "";
  private complete = false;
  constructor(
    private readonly terminalEvents: readonly string[],
    private readonly maxFrameBytes = 4 * 1024 * 1024
  ) {}
  write(chunk: Uint8Array) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (Buffer.byteLength(frame) > this.maxFrameBytes)
        throw new Error("HTTP/2 SSE frame exceeded bounded audit limit");
      const lines = frame.split(/\r?\n/);
      const event = lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (event && data && this.terminalEvents.includes(event)) this.complete = true;
      if (this.terminalEvents.includes(data.trim())) this.complete = true;
      if (!this.complete && data.startsWith("{")) {
        try {
          const value = JSON.parse(data) as { type?: unknown };
          if (typeof value.type === "string" && this.terminalEvents.includes(value.type))
            this.complete = true;
        } catch {
          /* Malformed chunks are not proof of terminal completion. */
        }
      }
    }
    if (Buffer.byteLength(this.pending) > this.maxFrameBytes)
      throw new Error("HTTP/2 SSE frame exceeded bounded audit limit");
  }
  finish() {
    if (!this.complete)
      throw new Error("HTTP/2 response interrupted before terminal SSE completion");
  }
}
