/**
 * Jina Foundation API proxy.
 *
 * Forwards classify / segment (and similar JSON POSTs) to Jina using the same
 * dashboard-or-env credentials as embeddings and rerank.
 */

import { CORS_HEADERS } from "../utils/cors.ts";
import { errorResponse } from "../utils/error.ts";
import { attachOmniRouteMetaHeaders } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { saveCallLog } from "@/lib/usageDb";
import { acquireConfiguredSharedAccountAdmission } from "../services/accountRequestAdmission.ts";

export interface JinaFoundationCredentials {
  apiKey?: string | null;
  accessToken?: string | null;
  connectionId?: string | null;
  maxConcurrent?: number | null;
  providerSpecificData?: Record<string, unknown> | null;
}

export interface JinaFoundationProxyOptions {
  path: string;
  upstreamUrl: string;
  body: Record<string, unknown>;
  credentials: JinaFoundationCredentials | null;
  provider?: string;
  model?: string | null;
  signal?: AbortSignal | null;
}

function cancellationResponse(
  callerSignal: AbortSignal | null | undefined,
  admissionSignal: AbortSignal | undefined
): Response | null {
  if (callerSignal?.aborted) return errorResponse(499, "Jina request cancelled");
  if (admissionSignal?.aborted) {
    return errorResponse(503, "Provider account capacity lease was lost during Jina request");
  }
  return null;
}

export async function handleJinaFoundationProxy(
  options: JinaFoundationProxyOptions
): Promise<Response> {
  const startTime = Date.now();
  const provider = options.provider || "jina-ai";
  const token = options.credentials?.apiKey || options.credentials?.accessToken;
  const connectionId = options.credentials?.connectionId || null;

  if (!token) {
    return errorResponse(401, `No credentials for Jina provider: ${provider}`);
  }

  let sharedAdmission: Awaited<ReturnType<typeof acquireConfiguredSharedAccountAdmission>> = null;
  try {
    sharedAdmission = await acquireConfiguredSharedAccountAdmission({
      provider,
      credentials: options.credentials,
      signal: options.signal ?? undefined,
    });
  } catch (error) {
    const admissionError = error as { code?: string; statusCode?: number; message?: string };
    if (admissionError.code === "ACCOUNT_ADMISSION_UNAVAILABLE") {
      return errorResponse(
        admissionError.statusCode || 503,
        admissionError.message || "Provider account capacity admission is unavailable"
      );
    }
    throw error;
  }
  const signal = sharedAdmission?.signal ?? options.signal ?? undefined;

  try {
    const cancelledBeforeFetch = cancellationResponse(options.signal, sharedAdmission?.signal);
    if (cancelledBeforeFetch) return cancelledBeforeFetch;
    signal?.throwIfAborted();
    const res = await fetch(options.upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(options.body),
      signal,
    });
    const cancelledAfterHeaders = cancellationResponse(options.signal, sharedAdmission?.signal);
    if (cancelledAfterHeaders) return cancelledAfterHeaders;

    const text = await res.text();
    const cancelledAfterBody = cancellationResponse(options.signal, sharedAdmission?.signal);
    if (cancelledAfterBody) return cancelledAfterBody;
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text.slice(0, 500) };
    }

    saveCallLog({
      method: "POST",
      path: options.path,
      status: res.status,
      model: options.model || `${provider}${options.path}`,
      provider,
      duration: Date.now() - startTime,
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      connectionId,
      ...(res.ok
        ? {}
        : {
            error:
              (parsed as { message?: string; error?: { message?: string } } | null)?.message ||
              (parsed as { error?: { message?: string } } | null)?.error?.message ||
              text.slice(0, 500),
          }),
    }).catch(() => {});

    if (!res.ok) {
      const err = parsed as { message?: string; error?: { message?: string } | string } | null;
      const message =
        err?.message ||
        (typeof err?.error === "string" ? err.error : err?.error?.message) ||
        `Provider returned HTTP ${res.status}`;
      return errorResponse(res.status, message);
    }

    const headers = new Headers({ ...CORS_HEADERS, "Content-Type": "application/json" });
    attachOmniRouteMetaHeaders(headers, {
      provider,
      model: options.model || provider,
      costUsd: 0,
      latencyMs: Date.now() - startTime,
      requestId: generateRequestId(),
    });
    return new Response(JSON.stringify(parsed), { status: 200, headers });
  } catch (err) {
    const cancelled = cancellationResponse(options.signal, sharedAdmission?.signal);
    if (cancelled) return cancelled;
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(500, `Jina request failed: ${message}`);
  } finally {
    sharedAdmission?.release();
  }
}
