/**
 * Server-owned principal for reasoning replay. Never construct it from request
 * fields or API key metadata: callers must validate the actual credential first.
 */
import { createHmac } from "node:crypto";

declare const reasoningCacheContextBrand: unique symbol;

export type ReasoningCacheContext = (
  Readonly<{ kind: "key"; fingerprint: string }> | Readonly<{ kind: "local" }>
) & { readonly [reasoningCacheContextBrand]: true };

// A structural lookalike, JSON round-trip, spread copy or client body is not a
// trusted context. Keep the original frozen instance through every dispatch.
const trustedContexts = new WeakSet<object>();

function trustContext(
  principal: { kind: "key"; fingerprint: string } | { kind: "local" }
): ReasoningCacheContext {
  const context = Object.freeze(principal) as ReasoningCacheContext;
  trustedContexts.add(context);
  return context;
}

/** Only trusted server callers may pass an already validated credential. */
export function createReasoningCacheKeyContext(
  validatedActualCredential: string
): ReasoningCacheContext | null {
  const secret = process.env.API_KEY_SECRET;
  if (
    !secret?.trim() ||
    typeof validatedActualCredential !== "string" ||
    !validatedActualCredential
  ) {
    return null;
  }
  const fingerprint = createHmac("sha256", secret)
    .update(JSON.stringify(["reasoning-cache-principal-v2", validatedActualCredential]))
    .digest("hex");
  return trustContext({ kind: "key", fingerprint });
}

/** Explicit trusted in-process use only; no-key HTTP is not a trusted local principal. */
export function createLocalReasoningCacheContext(): ReasoningCacheContext | null {
  if (!process.env.API_KEY_SECRET?.trim()) return null;
  return trustContext({ kind: "local" });
}

export function isTrustedReasoningCacheContext(value: unknown): value is ReasoningCacheContext {
  return typeof value === "object" && value !== null && trustedContexts.has(value);
}
