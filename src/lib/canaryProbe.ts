/** A readiness request must finish even when a component's health probe stalls. */
export async function boundedCanaryProbe<T>(
  probe: () => Promise<T>,
  fallback: T,
  timeoutMs = 1500
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(probe),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
