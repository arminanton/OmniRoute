const forcedReasoningEfforts = new WeakMap<object, string>();

function credentialsKey(credentials: unknown): object | null {
  return credentials !== null && (typeof credentials === "object" || typeof credentials === "function")
    ? credentials
    : null;
}

export function setForcedReasoningEffort(credentials: unknown, effort: unknown): void {
  const key = credentialsKey(credentials);
  if (!key) return;
  if (typeof effort === "string" && effort.length > 0) forcedReasoningEfforts.set(key, effort);
  else forcedReasoningEfforts.delete(key);
}

export function getForcedReasoningEffort(credentials: unknown): string | undefined {
  const key = credentialsKey(credentials);
  return key ? forcedReasoningEfforts.get(key) : undefined;
}
export function copyForcedReasoningEffort(source: unknown, target: unknown): void {
  const effort = getForcedReasoningEffort(source);
  if (effort) setForcedReasoningEffort(target, effort);
}
