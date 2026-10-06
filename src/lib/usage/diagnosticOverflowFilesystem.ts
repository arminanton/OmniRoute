import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { containsSensitiveErrorCredential } from "@omniroute/open-sse/utils/errorSanitization.ts";
import { DIAGNOSTIC_ID } from "./diagnosticOverflowTypes";
import type {
  DiagnosticOverflowAttemptMetadata,
  DiagnosticOverflowKind,
} from "./diagnosticOverflowTypes";
export function privateDirectory(directory: string, create = true): void {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      if (!create) throw new Error("diagnostic_directory_missing");
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("unsafe_diagnostic_directory");
    if (stat.uid !== 0 && stat.uid !== process.getuid?.())
      throw new Error("unsafe_diagnostic_parent_owner");
    const fixture =
      !!process.env.NODE_TEST_CONTEXT ||
      process.env.NODE_ENV === "test" ||
      process.argv.some((arg) => arg.includes("/tests/") || arg.startsWith("tests/"));
    if ((stat.mode & 0o022) !== 0 && !(fixture && (stat.mode & 0o1000) !== 0))
      throw new Error("unsafe_diagnostic_parent_permissions");
  }
  const stat = fs.lstatSync(absolute);
  if ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.())
    throw new Error("unsafe_diagnostic_permissions");
}
export function privateFile(filename: string): void {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error("unsafe_diagnostic_file");
  } finally {
    fs.closeSync(fd);
  }
}
export function syncDirectory(directory: string): void {
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function fileName(attemptId: string, kind: DiagnosticOverflowKind): string {
  if (
    !DIAGNOSTIC_ID.test(attemptId) ||
    !["client_request", "provider_request", "provider_response"].includes(kind)
  )
    throw new Error("unsafe_diagnostic_id");
  return `${attemptId}.${kind}.gz`;
}
export function safeReason(reason: string): string {
  return new Set([
    "abort",
    "client_unavailable",
    "deadline",
    "timeout",
    "cancel",
    "read_error",
    "write_error",
    "size_limit",
    "aggregate_budget",
    "upstream_error",
    "lease_lost",
    "writer_lease_expired",
    "capture_error",
    "attempt_limit",
    "backpressure_overflow",
    "missing_eof",
    "file_missing",
  ]).has(reason)
    ? reason
    : "capture_error";
}
export function safeRequestId(value?: string): string | undefined {
  if (!value) return undefined;
  return /^[a-f0-9-]{16,64}$/i.test(value)
    ? value
    : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
export function safeMetadata(
  input: DiagnosticOverflowAttemptMetadata = {}
): Omit<DiagnosticOverflowAttemptMetadata, "headers"> & { headers: Record<string, string> } {
  const result: Omit<DiagnosticOverflowAttemptMetadata, "headers"> & {
    headers: Record<string, string>;
  } = { headers: {} };
  for (const name of ["transport", "method"] as const)
    if (typeof input[name] === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(input[name]))
      result[name] = input[name];
  if (Number.isInteger(input.status) && Number(input.status) >= 100 && Number(input.status) <= 599)
    result.status = input.status;
  if (input.url)
    try {
      const url = new URL(input.url);
      if (["https:", "http:", "wss:", "ws:"].includes(url.protocol))
        result.url = `${url.protocol}//${url.host}${url.pathname}`.slice(0, 512);
    } catch {}
  const allowed = new Set([
    "content-type",
    "accept",
    "user-agent",
    "retry-after",
    "x-request-id",
    "x-goog-request-id",
    "x-google-request-id",
    "x-cloud-trace-context",
    "traceparent",
  ]);
  const entries =
    input.headers instanceof Headers
      ? input.headers.entries()
      : Object.entries(input.headers ?? {});
  for (const [key, value] of entries) {
    const name = key.toLowerCase();
    if (!allowed.has(name) || Object.keys(result.headers).length >= 16) continue;
    result.headers[name] =
      typeof value === "string" &&
      value.length <= 256 &&
      !/[\x00-\x1f]/.test(value) &&
      !containsSensitiveErrorCredential(value)
        ? value
        : "[redacted]";
  }
  return result;
}
