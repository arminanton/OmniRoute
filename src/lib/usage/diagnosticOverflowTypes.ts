import type { ReadStream } from "node:fs";
export const DIAGNOSTIC_OVERFLOW_SCHEMA = "omni-diagnostic-overflow/v1";
export const DIAGNOSTIC_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type DiagnosticOverflowState = "capturing" | "complete" | "incomplete";
export type DiagnosticOverflowKind = "client_request" | "provider_request" | "provider_response";
export type DiagnosticOverflowReadKind =
  DiagnosticOverflowKind | "client-request" | "request" | "response";
export interface DiagnosticOverflowFile {
  representation?:
    "parsed_json_reserialized_utf8" | "serialized_provider_request_utf8" | "decoded_upstream_bytes";
  state: DiagnosticOverflowState;
  complete: boolean;
  reason?: string;
  rawBytes: number;
  compressedBytes: number;
  sha256?: string;
  gzipSha256?: string;
}
export interface DiagnosticOverflowAttemptMetadata {
  transport?: string;
  method?: string;
  url?: string;
  status?: number;
  headers?: Headers | Record<string, string>;
}
export interface DiagnosticOverflowManifest {
  schema: typeof DIAGNOSTIC_OVERFLOW_SCHEMA;
  traceId: string;
  requestId?: string;
  provider: string;
  createdAt: number;
  sealedAt?: number;
  state: DiagnosticOverflowState;
  reasons: string[];
  clientRequest?: DiagnosticOverflowFile;
  attempts: Array<
    DiagnosticOverflowAttemptMetadata & {
      attemptId: string;
      headers: Record<string, string>;
      request: DiagnosticOverflowFile;
      response: DiagnosticOverflowFile;
    }
  >;
}
export interface DiagnosticOverflowReference {
  schema: typeof DIAGNOSTIC_OVERFLOW_SCHEMA;
  traceId: string;
  state: DiagnosticOverflowState;
  reason?: string;
  persisted?: boolean;
}
export type DiagnosticOverflowReadResult =
  | { state: "ready"; metadata: DiagnosticOverflowFile; stream: ReadStream }
  | { state: "capturing" | "missing" | "corrupt"; metadata?: DiagnosticOverflowFile };
export interface DiagnosticOverflowOptions {
  root: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  retentionMs?: number;
  leaseMs?: number;
}
export function projectDiagnosticOverflowReference(
  value: unknown
): DiagnosticOverflowReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (
    source.schema !== DIAGNOSTIC_OVERFLOW_SCHEMA ||
    typeof source.traceId !== "string" ||
    !DIAGNOSTIC_ID.test(source.traceId) ||
    !["capturing", "complete", "incomplete"].includes(String(source.state))
  )
    return undefined;
  return {
    schema: DIAGNOSTIC_OVERFLOW_SCHEMA,
    traceId: source.traceId,
    state: source.state as DiagnosticOverflowState,
    ...(source.persisted === false ? { persisted: false } : {}),
    ...(typeof source.reason === "string" &&
    [
      "aggregate_budget",
      "capture_error",
      "write_error",
      "lease_lost",
      "size_limit",
      "attempt_limit",
      "backpressure_overflow",
      "abort",
      "client_unavailable",
      "deadline",
      "timeout",
      "cancel",
      "read_error",
      "upstream_error",
      "missing_eof",
    ].includes(source.reason)
      ? { reason: source.reason }
      : {}),
  };
}
