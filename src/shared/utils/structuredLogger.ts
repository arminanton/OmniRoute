/**
 * Structured Logger — FASE-05 Code Quality
 *
 * Lightweight structured logging wrapper with JSON output for production
 * and human-readable output for development. Replaces scattered console.log
 * calls with consistent, parseable log entries.
 *
 * When APP_LOG_TO_FILE is enabled, log entries are also appended as JSON lines
 * to the application log file for the Console Log Viewer.
 *
 * @module shared/utils/structuredLogger
 */

import { getCorrelationId } from "../middleware/correlationId";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { getAppLogFilePath, getAppLogLevel, getAppLogToFile } from "@/lib/logEnv";

const LOG_LEVELS: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const currentLevel = LOG_LEVELS[getAppLogLevel("info").toLowerCase() || ""] || LOG_LEVELS.info;
const isProduction = process.env.NODE_ENV === "production";

// File logging configuration
const logToFile = getAppLogToFile();
const logFilePath = resolve(getAppLogFilePath());

// Ensure log directory exists once at module load
if (logToFile) {
  try {
    const dir = dirname(logFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } catch {
    // silently ignore — will retry on each write
  }
}

/**
 * Append a JSON log line to the log file (non-blocking best-effort).
 */
function writeToFile(entry: Record<string, unknown>) {
  if (!logToFile) return;
  try {
    appendFileSync(logFilePath, JSON.stringify(entry) + "\n");
  } catch {
    // Silently fail — file logging should never break the app
  }
}

function formatEntry(
  level: string,
  component: string,
  message: string,
  meta?: Record<string, unknown>
) {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...meta,
  };

  // Add correlation ID if available
  const correlationId = getCorrelationId() as string | undefined;
  if (correlationId) {
    entry.correlationId = correlationId;
  }

  if (isProduction) {
    return JSON.stringify(entry);
  }

  // Human-readable for development
  const metaStr = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  const corrStr = correlationId ? ` [${correlationId.slice(0, 8)}]` : "";
  return `[${entry.timestamp}] ${level.toUpperCase().padEnd(5)} [${component}]${corrStr} ${message}${metaStr}`;
}

function buildEntry(
  level: string,
  component: string,
  message: string,
  meta?: Record<string, unknown>
) {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...meta,
  };
  const correlationId = getCorrelationId() as string | undefined;
  if (correlationId) {
    entry.correlationId = correlationId;
  }
  return entry;
}

// EPIPE-safe error deduplication + rate limiting (#1006)
const _recentErrors = new Map<string, { count: number; firstSeen: number }>();
const DEDUP_WINDOW_MS = 5_000;
const MAX_WRITES_PER_SECOND = 50;
const MAX_TRACKED_ERROR_MESSAGE_CHARS = 4096;
const MAX_TRACKED_ERROR_COMPONENT_CHARS = 128;
// Keys include severity and component, so identical wording from separate providers is not
// collapsed. Message/component lengths and the number of keys are all bounded.
const MAX_TRACKED_ERRORS = 500;
let _writeCount = 0;
let _writeWindowStart = Date.now();
let _rateLimitedCount = 0;
let _pendingDeduplicatedMessages = 0;
let _pendingDuplicateErrors = 0;
let _pendingRateLimitedErrors = 0;

type SuppressionSummary = {
  deduplicatedErrorGroups: number;
  deduplicatedErrorCount: number;
  rateLimitedErrorCount: number;
};

function accumulateSuppressedEntry(entry: { count: number; firstSeen: number }): void {
  const duplicates = Math.max(0, entry.count - 1);
  if (duplicates > 0) {
    _pendingDeduplicatedMessages++;
    _pendingDuplicateErrors += duplicates;
  }
}

function pruneRecentErrors(now: number): void {
  // Always expire stale keys, even when the map is small or wall-clock adjustments reorder ages.
  // The full scan is bounded by MAX_TRACKED_ERRORS.
  for (const [key, entry] of _recentErrors) {
    if (now - entry.firstSeen < DEDUP_WINDOW_MS) continue;
    accumulateSuppressedEntry(entry);
    _recentErrors.delete(key);
  }
}

function makeRoomForRecentError(): void {
  if (_recentErrors.size < MAX_TRACKED_ERRORS) return;
  const oldest = _recentErrors.entries().next().value as
    [string, { count: number; firstSeen: number }] | undefined;
  if (!oldest) return;
  _recentErrors.delete(oldest[0]);
  accumulateSuppressedEntry(oldest[1]);
}

function takeSuppressionSummary(): SuppressionSummary | undefined {
  if (
    _pendingDeduplicatedMessages === 0 &&
    _pendingDuplicateErrors === 0 &&
    _pendingRateLimitedErrors === 0
  ) {
    return undefined;
  }
  const summary = {
    deduplicatedErrorGroups: _pendingDeduplicatedMessages,
    deduplicatedErrorCount: _pendingDuplicateErrors,
    rateLimitedErrorCount: _pendingRateLimitedErrors,
  };
  _pendingDeduplicatedMessages = 0;
  _pendingDuplicateErrors = 0;
  _pendingRateLimitedErrors = 0;
  return summary;
}

function shouldSuppressError(
  level: "error" | "fatal",
  component: string,
  message: string,
  now = Date.now()
): { suppress: boolean; summary?: SuppressionSummary } {
  const trackable =
    message.length <= MAX_TRACKED_ERROR_MESSAGE_CHARS &&
    component.length <= MAX_TRACKED_ERROR_COMPONENT_CHARS;
  const key = trackable ? `${level}\0${component}\0${message}` : undefined;
  pruneRecentErrors(now);

  // Rate limit: max writes per second. Carry the omitted count to the next emitted error/fatal
  // entry instead of losing it silently.
  if (now - _writeWindowStart >= 1000) {
    _pendingRateLimitedErrors += _rateLimitedCount;
    _rateLimitedCount = 0;
    _writeCount = 0;
    _writeWindowStart = now;
  }

  const existing = key === undefined ? undefined : _recentErrors.get(key);
  if (existing && now - existing.firstSeen < DEDUP_WINDOW_MS) {
    existing.count++;
    return { suppress: true };
  }

  if (_writeCount >= MAX_WRITES_PER_SECOND) {
    _rateLimitedCount++;
    return { suppress: true };
  }

  if (key !== undefined) {
    makeRoomForRecentError();
    _recentErrors.set(key, { count: 1, firstSeen: now });
  }
  _writeCount++;
  return { suppress: false, summary: takeSuppressionSummary() };
}

/** Test-only internals for verifying the dedup-map bound. */
export const __structuredLoggerInternals = {
  recentErrors: _recentErrors,
  pruneRecentErrors,
  makeRoomForRecentError,
  MAX_TRACKED_ERRORS,
  shouldSuppressError,
  resetRecentErrorsForTests(now = Date.now()) {
    _recentErrors.clear();
    _writeCount = 0;
    _writeWindowStart = now;
    _rateLimitedCount = 0;
    _pendingDeduplicatedMessages = 0;
    _pendingDuplicateErrors = 0;
    _pendingRateLimitedErrors = 0;
  },
  isStreamWritable,
};

/**
 * True when a stream can still accept a write.
 *
 * Exported via __structuredLoggerInternals for tests: the real process.stderr cannot be
 * destroyed in-process to exercise this, because the test runner writes its own output there.
 */
function isStreamWritable(stream: { destroyed?: boolean; writableEnded?: boolean }): boolean {
  return stream.destroyed !== true && stream.writableEnded !== true;
}

/**
 * Write a line to stderr, skipping the write entirely when the stream is already known-bad.
 *
 * The `try {} catch {}` this replaces could only ever catch a *synchronous* failure. On a
 * broken pipe the write fails asynchronously and surfaces as an 'error' event on the stream,
 * which — with no listener attached — Node re-throws as an uncaughtException. That is the
 * ignition point of the #8181 log-flood loop, and it fires from the very line whose comment
 * says raw stderr writes are used to *avoid* EPIPE loops.
 *
 * consoleInterceptor now attaches the listener that stops the loop; this guard is defence in
 * depth, so a dead stream is not written to in the first place. The catch is retained for the
 * synchronous cases it always covered.
 */
function safeStderrWrite(text: string): void {
  if (!isStreamWritable(process.stderr)) return;
  try {
    process.stderr.write(text);
  } catch {
    /* synchronous write failures remain non-fatal, as before */
  }
}

export function createLogger(component: string) {
  return {
    debug(message: string, meta?: Record<string, unknown>) {
      if (currentLevel <= LOG_LEVELS.debug) {
        const entry = buildEntry("debug", component, message, meta);
        console.debug(formatEntry("debug", component, message, meta));
        writeToFile(entry);
      }
    },
    info(message: string, meta?: Record<string, unknown>) {
      if (currentLevel <= LOG_LEVELS.info) {
        const entry = buildEntry("info", component, message, meta);
        console.info(formatEntry("info", component, message, meta));
        writeToFile(entry);
      }
    },
    warn(message: string, meta?: Record<string, unknown>) {
      if (currentLevel <= LOG_LEVELS.warn) {
        const entry = buildEntry("warn", component, message, meta);
        console.warn(formatEntry("warn", component, message, meta));
        writeToFile(entry);
      }
    },
    error(message: string, meta?: Record<string, unknown>) {
      if (currentLevel <= LOG_LEVELS.error) {
        const decision = shouldSuppressError("error", component, message);
        if (decision.suppress) return;
        const outputMeta = decision.summary ? { ...meta, logSuppression: decision.summary } : meta;
        const entry = buildEntry("error", component, message, outputMeta);
        // Use stderr.write to avoid Next.js console patching that triggers EPIPE loops.
        // Guarded: an unguarded write here is the ignition point of #8181.
        safeStderrWrite(formatEntry("error", component, message, outputMeta) + "\n");
        writeToFile(entry);
      }
    },
    fatal(message: string, meta?: Record<string, unknown>) {
      const decision = shouldSuppressError("fatal", component, message);
      if (decision.suppress) return;
      const outputMeta = decision.summary ? { ...meta, logSuppression: decision.summary } : meta;
      const entry = buildEntry("fatal", component, message, outputMeta);
      safeStderrWrite(formatEntry("fatal", component, message, outputMeta) + "\n");
      writeToFile(entry);
    },
    child(defaultMeta: Record<string, unknown>) {
      return createLogger(component);
    },
  };
}

export { LOG_LEVELS };
