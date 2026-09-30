/** Read MaxAI JSON with caller cancellation. No provider-specific size cap. */
export async function readMaxaiJson(response: Response, signal?: AbortSignal | null): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("MaxAI response unavailable");
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
