import { randomUUID } from "node:crypto";
import { FETCH_TIMEOUT_MS } from "../../config/constants.ts";
import { buildErrorBody } from "../../utils/error.ts";
import { type ExecutorLog } from "../base.ts";
import {
  buildGeminiThoughtSignatureKey,
  storeGeminiThoughtSignature,
} from "../../services/geminiThoughtSignatureStore.ts";
import {
  type AntigravityCollectedStream,
  processAntigravitySSEText,
  flushAntigravitySSEText,
} from "./sseCollect.ts";
import { combineAbortSignals, readWithCancellation } from "./lifecycle.ts";

export function collectAntigravityResponse(
  response: Response,
  model: string,
  url: string,
  headers: Record<string, string>,
  transformedBody: Record<string, unknown>,
  log?: ExecutorLog | null,
  signal?: AbortSignal | null,
  signatureNamespace?: string | null
) {
  if (!response.body) {
    return Promise.resolve({ response, url, headers, transformedBody });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const logger = log || undefined;

  // Guard against indefinite hangs when the upstream sends headers but
  // stalls on the body.  Inherit the global FETCH_TIMEOUT_MS (default 600 s,
  // overridable via env) so reasoning-heavy models (gemini-3.1-pro-high on
  // large prompts) are not killed by a hardcoded 120 s ceiling.
  const SSE_COLLECT_TIMEOUT_MS = FETCH_TIMEOUT_MS;

  const collect = async () => {
    const collected: AntigravityCollectedStream = {
      textContent: "",
      finishReason: "stop",
      toolCalls: [],
      usage: null,
      remainingCredits: null,
    };
    const partialLine = { value: "" };
    let failureStatus: number | null = null;
    const timeout = AbortSignal.timeout(SSE_COLLECT_TIMEOUT_MS);
    const readSignal = combineAbortSignals([timeout, ...(signal ? [signal] : [])]);
    try {
      while (true) {
        const { done, value } = await readWithCancellation(reader, readSignal);
        if (done) break;
        processAntigravitySSEText(
          decoder.decode(value, { stream: true }),
          partialLine,
          collected,
          logger
        );
        if (collected.upstreamError) {
          failureStatus = collected.upstreamError.status;
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } catch (err) {
      failureStatus = signal?.aborted ? 499 : timeout.aborted ? 504 : 502;
      log?.warn?.("SSE_COLLECT", `Antigravity stream interrupted (${failureStatus})`);
      // Cancel the reader we own; cancelling its locked source cannot work.
      if (typeof reader.cancel === "function") await reader.cancel(err).catch(() => {});
      else {
        // Compatibility for stream adapters that expose only read/releaseLock.
        reader.releaseLock();
        await response.body?.cancel().catch(() => {});
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_) {}
    }
    processAntigravitySSEText(decoder.decode(), partialLine, collected, logger);
    flushAntigravitySSEText(partialLine, collected, logger);
    failureStatus ??= collected.upstreamError?.status ?? null;
    if (collected.nativeCandidateSeen && !collected.completed) failureStatus ??= 502;
    if (failureStatus) {
      const errorResponse = new Response(
        JSON.stringify(
          buildErrorBody(
            failureStatus,
            failureStatus === 499
              ? "Request cancelled"
              : failureStatus === 504
                ? "Antigravity response timed out"
                : "Antigravity upstream response interrupted"
          )
        ),
        { status: failureStatus, headers: { "Content-Type": "application/json" } }
      );
      return { response: errorResponse, url, headers, transformedBody };
    }

    if (signatureNamespace) {
      for (const call of collected.toolCalls) {
        if (call.thought_signature)
          storeGeminiThoughtSignature(
            buildGeminiThoughtSignatureKey(signatureNamespace, call.id),
            call.thought_signature
          );
      }
    }
    const result = {
      id: `chatcmpl-${Date.now()}-${randomUUID().slice(0, 8)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message:
            collected.toolCalls.length > 0
              ? {
                  role: "assistant",
                  content: collected.textContent || null,
                  tool_calls: collected.toolCalls,
                }
              : { role: "assistant", content: collected.textContent },
          finish_reason: collected.toolCalls.length > 0 ? "tool_calls" : collected.finishReason,
        },
      ],
      ...(collected.usage && { usage: collected.usage }),
      // Expose credit balance for upstream consumers (usage service, dashboard)
      ...(collected.remainingCredits && { _remainingCredits: collected.remainingCredits }),
    };

    const syntheticResponse = new Response(JSON.stringify(result), {
      status: response.status,
      statusText: response.statusText,
      headers: [["Content-Type", "application/json"]],
    });

    return { response: syntheticResponse, url, headers, transformedBody };
  };

  return collect();
}
