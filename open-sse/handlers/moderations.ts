import { CORS_HEADERS } from "../utils/cors.ts";
/**
 * Moderation Handler
 *
 * Handles POST /v1/moderations (OpenAI Moderations API format).
 */

import { getModerationProvider, parseModerationModel } from "../config/moderationRegistry.ts";
import { errorResponse, sanitizeErrorMessage } from "../utils/error.ts";
import { buildSanitizedUpstreamErrorResponse } from "../utils/upstreamErrorResponse.ts";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { acquireConfiguredSharedAccountAdmission } from "../services/accountRequestAdmission.ts";

function cancellationResponse(
  callerSignal: AbortSignal | undefined,
  admissionSignal: AbortSignal | undefined
): Response | null {
  if (callerSignal?.aborted) return errorResponse(499, "Moderation request cancelled");
  if (admissionSignal?.aborted) {
    return errorResponse(503, "Provider account capacity lease was lost during moderation");
  }
  return null;
}

/**
 * Handle moderation request
 *
 * @param {Object} options
 * @param {Object} options.body - JSON body { model, input }
 * @param {Object} options.credentials - Provider credentials { apiKey }
 * @param {AbortSignal} [options.signal] - Caller cancellation signal
 * @returns {Response}
 */
/** @returns {Promise<unknown>} */
export async function handleModeration({ body, credentials, signal }) {
  const startTime = Date.now();
  if (!body.input) {
    return errorResponse(400, "input is required");
  }

  // Default to latest moderation model
  const model = body.model || "omni-moderation-latest";
  const { provider: providerId, model: modelId } = parseModerationModel(model);
  const providerConfig = providerId ? getModerationProvider(providerId) : null;

  if (!providerConfig) {
    return errorResponse(
      400,
      `No moderation provider found for model "${model}". Available: openai`
    );
  }

  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) {
    return errorResponse(401, `No credentials for moderation provider: ${providerId}`);
  }

  let sharedAdmission = null;
  try {
    try {
      sharedAdmission = await acquireConfiguredSharedAccountAdmission({
        provider: providerId || "openai",
        credentials,
        signal,
      });
    } catch (error) {
      const admissionError = error;
      if (admissionError?.code === "ACCOUNT_ADMISSION_UNAVAILABLE") {
        return errorResponse(
          admissionError.statusCode || 503,
          admissionError.message || "Provider account capacity admission is unavailable"
        );
      }
      throw error;
    }
    const requestSignal = sharedAdmission?.signal ?? signal;
    const cancelledBeforeFetch = cancellationResponse(signal, sharedAdmission?.signal);
    if (cancelledBeforeFetch) return cancelledBeforeFetch;
    requestSignal?.throwIfAborted();
    const res = await fetch(providerConfig.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: modelId,
        input: body.input,
      }),
      signal: requestSignal,
    });
    const cancelledAfterHeaders = cancellationResponse(signal, sharedAdmission?.signal);
    if (cancelledAfterHeaders) return cancelledAfterHeaders;

    if (!res.ok) {
      const errText = await res.text();
      const cancelledAfterErrorBody = cancellationResponse(signal, sharedAdmission?.signal);
      if (cancelledAfterErrorBody) return cancelledAfterErrorBody;
      return buildSanitizedUpstreamErrorResponse({
        status: res.status,
        rawBody: errText,
        fallbackMessage: `Moderation provider returned HTTP ${res.status}`,
        headers: CORS_HEADERS,
      });
    }

    const data = await res.json();
    const cancelledAfterBody = cancellationResponse(signal, sharedAdmission?.signal);
    if (cancelledAfterBody) return cancelledAfterBody;
    const headers = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json" });
    attachOmniRouteMetaHeaders(headers, {
      provider: providerId,
      model: modelId,
      costUsd: 0,
      latencyMs: Date.now() - startTime,
      requestId: generateRequestId(),
    });
    return new Response(JSON.stringify(data), { status: 200, headers });
  } catch (err) {
    const cancelled = cancellationResponse(signal, sharedAdmission?.signal);
    if (cancelled) return cancelled;
    const safeDetail =
      sanitizeErrorMessage(err)
        .replace(/^[A-Za-z]*Error:\s*/, "")
        .trim() || "unknown upstream failure";
    return errorResponse(500, `Moderation request failed: ${safeDetail}`);
  } finally {
    sharedAdmission?.release();
  }
}
