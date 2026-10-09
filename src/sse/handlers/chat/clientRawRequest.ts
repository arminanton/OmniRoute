/**
 * The clientRawRequest envelope — the observability snapshot of a chat request.
 *
 * Extracted from chat.ts (#7847). Both helpers are about the same object: one builds it, the
 * other merges a per-target abort signal into it before dispatch. Neither belongs in the
 * request handler proper, and chat.ts sits against a frozen file-size ratchet.
 *
 * chat.ts re-exports both, so the public surface and tests/unit/chat-build-client-raw-request
 * are unchanged.
 */
import { mergeAbortSignals } from "@omniroute/open-sse/executors/base.ts";
import { cloneBoundedForLog } from "@omniroute/open-sse/utils/requestLogger.ts";
import { getChatLogClientTextLimit } from "@/lib/logEnv";
import { getAdmittedRawRequestBodyBytes } from "@/shared/middleware/chatBodyAdmission";

import {
  recordDiagnosticClientBytes,
  recordDiagnosticClientJson,
  inheritDiagnosticClientJson,
} from "@omniroute/open-sse/utils/diagnosticCaptureContext.ts";

export function buildClientRawRequest(
  request: Request,
  body: unknown,
  diagnosticOverflowEligible = false
) {
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers.entries());
  delete headers["x-omniroute-lease-owner"];
  delete headers["x-omniroute-lease-generation"];
  const envelope = {
    endpoint: url.pathname,
    // #7847: bounded, not a full deep clone. Every consumer of clientRawRequest.body is
    // observability — reqLogger.logClientRawRequest (which re-bounds it anyway, or drops it
    // entirely when the logger is disabled), trackPendingRequest's `clientRequest`, and
    // recordRejectedRequestUsage's `requestBody`. None feeds dispatch, translation or the
    // upstream call, so cloning the whole payload retained ~41x more than anything kept:
    // 3.19 MiB vs 0.08 MiB on the incident's 3.05 MiB / 729-message request.
    // Still a clone, not an alias — `body` is rewritten downstream (plugin onRequest hook,
    // compression), and this has to stay a snapshot of what the client actually sent.
    body: cloneBoundedForLog(body, 0, null, getChatLogClientTextLimit()),
    headers,
    // Dispatch copies can merge per-target cancellation into `signal`; retain
    // the original caller signal so readiness does not report that timeout as 499.
    callerSignal: request.signal ?? null,
    signal: request.signal ?? null,
  };
  const admittedBytes = getAdmittedRawRequestBodyBytes(request);
  if (admittedBytes)
    recordDiagnosticClientBytes(envelope, admittedBytes, diagnosticOverflowEligible);
  else recordDiagnosticClientJson(envelope, body, diagnosticOverflowEligible);
  return envelope;
}

/**
 * #7360 follow-up: chatCore.ts's createStreamController (and, downstream,
 * withRateLimit/acquireAccountSemaphore) watches clientRawRequest.signal,
 * which is the original client signal merged with the current combo target's
 * cancellation signal. Keep callerSignal separately for code that must tell a
 * real client disconnect from a per-target timeout. A target abandoned by
 * comboTargetTimeoutMs (open-sse/services/combo/targetTimeoutRunner.ts)
 * never learns it was abandoned, and hangs forever (leaking a permanent
 * "pending" dashboard entry — trackPendingRequest(false) never runs; live
 * incident, log id 1784418258231-14961a). Merges the per-target
 * modelAbortSignal (when present) into clientRawRequest.signal so an
 * abandoned dispatch can actually observe its own abort and reach its
 * cleanup path — returns clientRawRequest unchanged when there's no
 * modelAbortSignal to merge in (the non-combo / non-timed-out common case).
 */
export function resolveDispatchClientRawRequest(
  clientRawRequest:
    { signal?: AbortSignal | null; callerSignal?: AbortSignal | null } | null | undefined,
  modelAbortSignal: AbortSignal | null | undefined
): typeof clientRawRequest {
  if (!modelAbortSignal) return clientRawRequest;
  const callerSignal =
    clientRawRequest?.callerSignal !== undefined
      ? clientRawRequest.callerSignal
      : (clientRawRequest?.signal ?? null);
  const copy = {
    ...clientRawRequest,
    callerSignal,
    signal: clientRawRequest?.signal
      ? mergeAbortSignals(clientRawRequest.signal, modelAbortSignal)
      : modelAbortSignal,
  };
  if (clientRawRequest) inheritDiagnosticClientJson(clientRawRequest, copy);
  return copy;
}
