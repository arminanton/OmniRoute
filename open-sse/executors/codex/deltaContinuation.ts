import { createHash } from "node:crypto";

export interface CodexContinuationState {
  responseId: string;
  requestFingerprint: string;
  baseline: unknown[];
  bytes: number;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .filter((k) => row[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(row[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(body: Record<string, unknown>): string {
  const { input: _input, previous_response_id: _previous, stream: _stream, ...contract } = body;
  return createHash("sha256").update(stable(contract)).digest("hex");
}

/** Only optimize a caller's complete history. Caller-owned previous IDs pass through unchanged. */
export function prepareCodexContinuation(
  body: Record<string, unknown>,
  state: CodexContinuationState | null
): { body: Record<string, unknown>; incremental: boolean } {
  if (
    !state ||
    body.previous_response_id ||
    !Array.isArray(body.input) ||
    fingerprint(body) !== state.requestFingerprint ||
    body.input.length < state.baseline.length
  ) {
    return { body, incremental: false };
  }
  for (let i = 0; i < state.baseline.length; i++) {
    if (stable(body.input[i]) !== stable(state.baseline[i])) return { body, incremental: false };
  }
  const delta = body.input.slice(state.baseline.length);
  if (!delta.length) return { body, incremental: false };
  return {
    body: { ...body, input: delta, previous_response_id: state.responseId },
    incremental: true,
  };
}

export function commitCodexContinuation(
  fullBody: Record<string, unknown>,
  response: Record<string, unknown>,
  maxBytes: number
): CodexContinuationState | null {
  if (
    fullBody.previous_response_id ||
    !Array.isArray(fullBody.input) ||
    typeof response.id !== "string" ||
    !response.id ||
    response.status !== "completed" ||
    !Array.isArray(response.output)
  )
    return null;
  const baseline = [...fullBody.input, ...response.output];
  const encoded = stable(baseline);
  const bytes = Buffer.byteLength(encoded);
  if (bytes > maxBytes) return null;
  return {
    responseId: response.id,
    requestFingerprint: fingerprint(fullBody),
    baseline: JSON.parse(encoded),
    bytes,
  };
}
