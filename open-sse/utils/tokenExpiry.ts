/** Normalize stored ISO, epoch-seconds, or epoch-milliseconds token expiry. */
export function parseTokenExpiryMs(expiresAt: unknown): number {
  let value: number;
  if (typeof expiresAt === "number") {
    value = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  } else if (typeof expiresAt === "string" && expiresAt.trim()) {
    const text = expiresAt.trim();
    if (/^[+-]?\d+(\.\d+)?$/.test(text)) {
      const numeric = Number(text);
      value = numeric < 1e12 ? numeric * 1000 : numeric;
    } else {
      value = Date.parse(text);
    }
  } else {
    return 0;
  }
  return Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : 0;
}
