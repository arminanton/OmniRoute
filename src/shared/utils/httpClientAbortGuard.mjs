"use strict";

import { isProxyFetchExhaustedTransportError } from "./proxyFetchProvenance.mjs";

/**
 * HTTP client-abort crash guard (#fix-dev-server-aborted).
 *
 * Node's http.Server turns an 'error' event on an IncomingMessage/ServerResponse
 * into an uncaughtException (and therefore a process exit) WHENEVER the emitter
 * has no listener. The single most common such error is a *client* abort: the
 * browser closes the TCP socket (navigation, Back/Forward cache, HMR reconnect,
 * cancelling a fetch) while the server is still streaming the response. Node
 * emits `Error: aborted` / `ERR_STREAM_PREMATURE_CLOSE` / `ECONNRESET` on the
 * request stream, and absent a handler it kills the whole server process.
 *
 * That surfaced as "login succeeds, then the dashboard hangs with a wall of
 * `net::ERR_CONNECTION_REFUSED`": after auth the SPA opens many polling
 * connections + a live WebSocket; stray client-side socket closes during
 * navigation/HMR were taking the dev server down.
 *
 * Two layers:
 *   1. `attachRequestStreamGuards(req, res)` — per-request listeners that absorb
 *      client-abort errors so they never bubble to the process level. Call it
 *      inside every `http.createServer((req, res) => …)` request listener.
 *   2. `installProcessCrashGuard()` — a last-resort safety net on
 *      `process.on('uncaughtException' | 'unhandledRejection')` that swallows
 *      the same benign client-abort errors but otherwise preserves the existing
 *      crash semantics (so genuine bugs still surface). Idempotent.
 *
 * Kept as a `.mjs` module (no build step) so it is importable both from the
 * Node-only dev server (`scripts/dev/run-next.mjs`) and from the TypeScript
 * servers under `src/` (tsconfig `allowJs: true`).
 *
 * @module
 */

/** @param {unknown} value @returns {value is Error} */
function isError(value) {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/** @param {Error} error @param {string[]} names @returns {Record<string, unknown> | undefined} */
function readErrorProperties(error, names) {
  try {
    /** @type {Record<string, unknown>} */
    const properties = {};
    for (const name of names) properties[name] = Reflect.get(error, name);
    return properties;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} err
 * @returns {boolean} true when `err` represents a client closing the
 *   connection rather than a server-side fault.
 */
export function isClientAbortError(err) {
  if (!isError(err)) return false;
  const e = readErrorProperties(err, ["message", "name", "code"]);
  if (!e) return false;
  const { message, name, code } = e;
  // Node emits `Error: aborted` (no code) from http.Server#abortIncoming.
  if (
    typeof message === "string" &&
    (message === "aborted" || message === "Aborted")
  ) return true;
  // OmniRoute's SSE teardown aborts in-flight legs with
  // `Error [AbortError]: request_signal_aborted` on client disconnects
  // (open-sse/utils/streamHandler.ts), and fetch/DOM cancellation surfaces as
  // `AbortError` with an abort-flavoured message. Same benign class as
  // `Error: aborted` — an emitter-left 'error' event on any of these used to
  // kill the process (#fix-dev-server-aborted).
  if (
    typeof name === "string" &&
    name === "AbortError" &&
    typeof message === "string" &&
    /abort/i.test(message)
  ) return true;
  if (typeof code !== "string") return false;
  switch (code) {
    case "ERR_STREAM_PREMATURE_CLOSE":
    case "ECONNRESET":
    case "EPIPE":
    case "ECONNABORTED":
    case "ETIMEDOUT":
    case "ENOTCONN":
    case "ECANCELED":
      return true;
    default:
      return false;
  }
}

/**
 * RELAY_TIMEOUT is already handled by the request layer; only a stray copy
 * reaching the process-level crash guard should be treated as recoverable.
 * Keep these literals in sync with open-sse/utils/proxyFetch.ts.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRecoverableUpstreamTimeoutError(err) {
  if (err === "RELAY_TIMEOUT" || err === "relay_timeout") return true;
  if (!isError(err)) return false;
  const e = readErrorProperties(err, ["code", "errorCode"]);
  return !!e &&
    ((typeof e.code === "string" && e.code === "RELAY_TIMEOUT") ||
      (typeof e.errorCode === "string" && e.errorCode === "relay_timeout"));
}

const PROXY_NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_HTTP2_STREAM_ERROR",
]);

/** Require private proxyFetch provenance and the explicit transport cause.
 * @param {unknown} err
 */
function isRecoverableProxyNetworkError(err) {
  if (!isProxyFetchExhaustedTransportError(err) || !isError(err)) return false;
  const e = readErrorProperties(err, ["code", "errorCode", "causeCode", "cause"]);
  if (!e) return false;
  const markedProxyFailure =
    (typeof e.code === "string" && e.code === "PROXY_REQUEST_FAILED") ||
    (typeof e.code === "string" && e.code === "PROXY_UNREACHABLE" &&
      typeof e.errorCode === "string" && e.errorCode === "proxy_unreachable");
  if (!markedProxyFailure) return false;
  let causeCode = e.causeCode;
  if (causeCode === null || causeCode === undefined) {
    const causeError = e.cause;
    if (!isError(causeError)) return false;
    const cause = readErrorProperties(causeError, ["code"]);
    if (!cause) return false;
    causeCode = cause.code;
  }
  return typeof causeCode === "string" && PROXY_NETWORK_ERROR_CODES.has(causeCode);
}

/**
 * Decide whether a process-level uncaughtException/unhandledRejection should be
 * swallowed (benign client-abort or recognized recoverable upstream failure) or
 * allowed to surface (genuine bug).
 *
 * Pure + exported so it can be unit-tested without poking process listeners.
 *
 * @param {unknown} err
 * @param {string | undefined} origin  Node's uncaughtException origin (e.g.
 *   "uncaughtException" / "unhandledRejection"); absent/empty for rejections.
 * @returns {boolean} true => swallow (log only), false => re-throw / let crash.
 */
export function shouldSwallowUncaught(err, origin) {
  if (
    !isClientAbortError(err) &&
    !isRecoverableUpstreamTimeoutError(err) &&
    !isRecoverableProxyNetworkError(err)
  ) {
    return false;
  }
  // Only swallow when the origin matches what the guard installed for. If some
  // other subsystem raised it (e.g. a deliberate `throw` in a domain), keep the
  // existing crash semantics.
  return !origin || origin === "uncaughtException" || origin === "unhandledRejection";
}

/**
 * Attach `error` listeners to a request/response pair that swallow client-abort
 * errors. Idempotent per (req, res) pair via a Symbol flag.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
export function attachRequestStreamGuards(req, res) {
  const flag = Symbol.for("omniroute.requestAbortGuard");
  if (req[flag] || res[flag]) return;
  req[flag] = true;
  res[flag] = true;

  req.on("error", (err) => {
    if (!isClientAbortError(err)) {
      // Re-emit a genuine request error through the normal channel so it is
      // still observable in logs, but never as an uncaughtException.
      console.error("[server] request stream error:", err);
    }
  });

  res.on("error", (err) => {
    if (!isClientAbortError(err)) {
      console.error("[server] response stream error:", err);
    }
  });
}

let crashGuardInstalled = false;

/**
 * Install process-level safety nets. Idempotent. Benign client-abort errors are
 * logged once and swallowed; everything else is re-thrown on a fresh stack so
 * the process keeps its current crash semantics (genuine bugs still crash/hang
 * loudly, and a supervisor or test harness sees them).
 *
 * @param {(level: "warn" | "error", ...args: unknown[]) => void} [log]
 */
export function installProcessCrashGuard(log) {
  if (crashGuardInstalled) return;
  crashGuardInstalled = true;

  // `console` is an object, not a callable: `log ?? console` followed by
  // `logger("warn", ...)` throws TypeError and kills the process on the very
  // abort the guard exists to swallow. Default to console.warn as a function.
  const logger = typeof log === "function" ? log : console.warn.bind(console);
  /** @param {unknown} value */
  const errorMessage = (value) => {
    if (typeof value === "string") return value;
    if (!isError(value)) return value;
    const properties = readErrorProperties(value, ["message"]);
    return properties && typeof properties.message === "string" ? properties.message : value;
  };

  process.on("uncaughtException", (err, origin) => {
    if (shouldSwallowUncaught(err, origin)) {
      logger("warn", "[server] swallowed client-abort uncaughtException:", errorMessage(err));
      return;
    }
    throw err;
  });

  process.on("unhandledRejection", (reason) => {
    if (shouldSwallowUncaught(reason, "unhandledRejection")) {
      logger(
        "warn",
        "[server] swallowed client-abort unhandledRejection:",
        errorMessage(reason)
      );
      return;
    }
    throw reason;
  });
}
