// Bound the headers-wait phase separately from streaming body inactivity and
// local admission queues. This is OmniRoute's conservative compatibility policy;
// it is not a Codex CLI hard abort deadline. The inspected CLI v0.160.0 defines
// a configurable 300_000ms stream idle timeout and 15_000ms WebSocket connect
// timeout in codex-rs/model-provider-info/src/lib.rs. Those are different phases.
// Caller cancellation remains authoritative. Non-streaming requests retain their
// configured base timeout.

export type FetchStartTimeoutPolicyInput = {
  baseTimeoutMs: number;
  /** Only streaming requests are capped — non-streaming keeps the flat default. */
  stream?: boolean | null;
  capMs?: number;
};

export type FetchStartTimeoutPolicyResult = {
  timeoutMs: number;
  baseTimeoutMs: number;
  /** True when the base timeout was reduced by the streaming cap. */
  capped: boolean;
};

// Retained public compatibility constant; this is not a verified native CLI deadline.
export const CODEX_CLIENT_ABORT_MS = 120_000;
export const DEFAULT_FETCH_START_TIMEOUT_CAP_MS = 110_000;

export function resolveFetchStartTimeout(
  input: FetchStartTimeoutPolicyInput
): FetchStartTimeoutPolicyResult {
  const baseTimeoutMs = Math.max(0, Math.floor(input.baseTimeoutMs || 0));
  if (baseTimeoutMs <= 0 || !input.stream) {
    return { timeoutMs: baseTimeoutMs, baseTimeoutMs, capped: false };
  }

  const capMs = Math.max(0, Math.floor(input.capMs ?? DEFAULT_FETCH_START_TIMEOUT_CAP_MS));
  if (capMs <= 0 || baseTimeoutMs <= capMs) {
    return { timeoutMs: baseTimeoutMs, baseTimeoutMs, capped: false };
  }

  return { timeoutMs: capMs, baseTimeoutMs, capped: true };
}
