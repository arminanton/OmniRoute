/** Transport admission is separate from provider/account quota and routing choices. */
export class BoundedAdmission {
  private active = 0;
  private closed = false;
  private queue: {
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }[] = [];
  constructor(
    private readonly concurrency: number,
    private readonly queueLimit = 128,
    private readonly queueTimeoutMs = 30000
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error("Invalid transport concurrency");
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 1)
      throw new Error("Invalid transport queue deadline");
    if (!Number.isInteger(queueLimit) || queueLimit < 0)
      throw new Error("Invalid transport queue limit");
  }
  stats() {
    return { active: this.active, queued: this.queue.length };
  }
  async acquire(signal?: AbortSignal | null): Promise<() => void> {
    if (this.closed) throw new Error("Transport admission closed");
    signal?.throwIfAborted();
    if (this.active < this.concurrency) {
      this.active++;
      return this.releaseOnce();
    }
    if (this.queue.length >= this.queueLimit) throw new Error("Transport admission queue full");
    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        entry.cleanup();
        reject(error);
      };
      const aborted = () => fail(new DOMException("Transport admission cancelled", "AbortError"));
      const timer = setTimeout(
        () => fail(new Error("Transport admission queue timeout")),
        this.queueTimeoutMs
      );
      const entry = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", aborted);
        },
      };
      this.queue.push(entry);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      entry.cleanup();
      entry.reject(new Error("Transport admission closed"));
    }
  }
  private releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next.cleanup();
        next.resolve(this.releaseOnce());
      } else this.active--;
    };
  }
}
