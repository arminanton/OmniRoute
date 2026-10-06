export const UPSTREAM_POLICY_REJECTION = "upstream_policy_rejection";
export interface NativePolicyError {
  message: string;
  code?: string;
  type?: string;
  requestId?: string;
  responseId?: string;
  wireStatus?: number;
}
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length ? value : undefined;
const codes = new Set([
  "content_policy_violation",
  "safety_violation",
  "safety_check_failed",
  "policy_violation",
]);
/** Applies to error envelopes/exceptions, never ordinary model output/refusals. */
export function classifyUpstreamPolicyRejection(value: unknown): NativePolicyError | null {
  let input = value;
  if (typeof value === "string") {
    try {
      input = JSON.parse(value);
    } catch {
      input = { message: value };
    }
  }
  const root = record(input);
  if (!root) return null;
  const response = record(root.response);
  const nested = record(root.error) ?? record(response?.error) ?? root;
  const message = string(nested.message) ?? string(root.message) ?? "";
  const code = string(nested.code) ?? string(root.errorCode);
  const type = string(nested.type) ?? string(root.errorType);
  const recognized =
    codes.has(String(code ?? "").toLowerCase()) ||
    type === UPSTREAM_POLICY_REJECTION ||
    code === UPSTREAM_POLICY_REJECTION ||
    /blocked by (?:our|the) safety systems|potentially unintended activity|request (?:was |has been )?blocked.{0,40}safety/i.test(
      message
    );
  if (!recognized) return null;
  const requestId = string(nested.request_id) ?? string(root.requestId) ?? string(root.request_id);
  const responseId = string(response?.id) ?? string(root.responseId);
  const wireStatus = typeof root.wireStatus === "number" ? root.wireStatus : undefined;
  return {
    message: message || "Upstream rejected this request under its safety policy",
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(requestId ? { requestId } : {}),
    ...(responseId ? { responseId } : {}),
    ...(wireStatus ? { wireStatus } : {}),
  };
}
export class UpstreamPolicyRejectionError extends Error {
  readonly errorType = UPSTREAM_POLICY_REJECTION;
  readonly code = UPSTREAM_POLICY_REJECTION;
  constructor(readonly nativeError: NativePolicyError) {
    super(nativeError.message);
  }
}
