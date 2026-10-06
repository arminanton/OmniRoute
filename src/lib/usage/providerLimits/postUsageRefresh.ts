/** Coalesce Antigravity usage refreshes through both the timer and network phase. */
export function resolvePostUsageRefreshDelayMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS;
  if (raw == null || raw.trim() === "") return 5000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}

export function createPostUsageRefreshScheduler(
  refresh: (connectionId: string) => Promise<unknown>,
  getDelay: () => number = resolvePostUsageRefreshDelayMs,
  onError: (connectionId: string, error: unknown) => void = () => {}
): (connectionId: string) => void {
  const pending = new Set<string>();
  return (connectionId) => {
    if (!connectionId || pending.has(connectionId)) return;
    pending.add(connectionId);
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() => refresh(connectionId))
        .catch((error) => {
          onError(connectionId, error);
        })
        .finally(() => pending.delete(connectionId));
    }, getDelay());
    timer.unref?.();
  };
}
