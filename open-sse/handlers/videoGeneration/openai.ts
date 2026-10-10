import {
  fetchWithTimeout,
  FetchTimeoutError,
  getConfiguredTimeout,
} from "@/shared/utils/fetchTimeout";
import { saveCallLog } from "@/lib/usageDb";
import { sanitizeErrorMessage } from "../../utils/error.ts";
import { getAccountAdmissionAbortStatus } from "../../services/accountRequestAdmission.ts";

interface LogLike {
  info?: (tag: string, msg: string, meta?: unknown) => void;
  error?: (tag: string, msg: string) => void;
}

interface CredentialsLike {
  providerSpecificData?: { baseUrl?: unknown } | null;
  baseUrl?: unknown;
  apiKey?: unknown;
  accessToken?: unknown;
}

type VideoEndpointResult =
  | { success: true; status: number; data: { created: number; data: unknown[] } }
  | { success: false; status: number; terminal?: true; error: string };

/**
 * Resolve the video generation endpoint URL from credentials and fallback.
 * Handles baseUrl from providerSpecificData or top-level credentials.
 */
function resolveVideoEndpoint(credentials: unknown, fallback: string): string {
  const creds = credentials as CredentialsLike | null | undefined;
  const psdBaseUrl =
    creds?.providerSpecificData?.baseUrl != null &&
    typeof creds.providerSpecificData.baseUrl === "string" &&
    creds.providerSpecificData.baseUrl.trim()
      ? creds.providerSpecificData.baseUrl.trim()
      : null;
  const topLevelBaseUrl =
    creds?.baseUrl != null && typeof creds.baseUrl === "string" && creds.baseUrl.trim()
      ? creds.baseUrl.trim()
      : null;
  const nodeBaseUrl = psdBaseUrl || topLevelBaseUrl;
  // Узел своего адреса может не иметь — у встроенных провайдеров его и не
  // бывает. Тогда работает `fallback`: это готовый endpoint из реестра, а не
  // корень, поэтому путь к нему не дописывается (у nanogpt адрес оканчивается
  // на /video/generations — в единственном числе).
  if (!nodeBaseUrl) return fallback;
  let n = nodeBaseUrl;
  while (n.endsWith("/")) n = n.slice(0, -1);
  if (n.endsWith("/videos/generations")) return n;
  return `${n}/videos/generations`;
}

/**
 * Fetch the video generation endpoint with timeout and error handling.
 */
async function fetchVideoEndpoint(
  url: string,
  {
    headers,
    body,
    log,
    signal,
    callerSignal,
    admissionSignal,
  }: {
    headers: Record<string, string>;
    body: string;
    log?: LogLike;
    signal?: AbortSignal | null;
    callerSignal?: AbortSignal | null;
    admissionSignal?: AbortSignal | null;
  }
): Promise<VideoEndpointResult> {
  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body,
      timeoutMs: getConfiguredTimeout(),
      signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("VIDEO", `Upstream ${response.status} for ${url}: ${errorText}`);
      return {
        success: false,
        status: response.status,
        ...(response.status === 408 || response.status >= 500 ? { terminal: true } : {}),
        error: errorText,
      };
    }
    const data = await response.json();
    return {
      success: true,
      status: response.status,
      data: { created: data.created || Math.floor(Date.now() / 1000), data: data.data || [] },
    };
  } catch (err) {
    const message = err?.message;
    const abortStatus = getAccountAdmissionAbortStatus(callerSignal, admissionSignal);
    const isTimeout = err instanceof FetchTimeoutError || err?.name === "AbortError";
    const safeMessage = sanitizeErrorMessage(message || err);
    const failureLabel =
      abortStatus === 499
        ? "Caller cancelled"
        : abortStatus === 503
          ? "Shared account lease lost"
          : isTimeout
            ? "Timeout"
            : "Request error";
    log?.error?.("VIDEO", `${failureLabel} for ${url}: ${safeMessage}`);
    return {
      success: false,
      status: abortStatus ?? (isTimeout ? 504 : 502),
      ...(abortStatus !== null ? { terminal: true } : {}),
      // A transport failure after dispatch has an ambiguous acceptance state.
      // Do not let a combo submit the same expensive generation to a fallback.
      ...(isTimeout || (!abortStatus && !err?.status) ? { terminal: true } : {}),
      error:
        abortStatus === 499
          ? "Video request cancelled by caller"
          : abortStatus === 503
            ? "Video request stopped after shared account lease loss"
            : `Video provider error: ${safeMessage}`,
    };
  }
}

/**
 * Handle OpenAI-compatible video generation.
 * This handler is dispatched for custom providers with format "openai-video".
 */
export async function handleOpenAIVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
  signal,
  callerSignal,
  admissionSignal,
}: {
  model: string;
  provider: string;
  providerConfig: { baseUrl: string; authHeader: string };
  body: unknown;
  credentials: unknown;
  log?: LogLike;
  /** Active transport signal (caller signal or the configured shared lease). */
  signal?: AbortSignal | null;
  callerSignal?: AbortSignal | null;
  admissionSignal?: AbortSignal | null;
}) {
  const startTime = Date.now();
  const creds = credentials as CredentialsLike | null | undefined;
  const apiToken = creds?.apiKey || creds?.accessToken;
  const endpoint = resolveVideoEndpoint(credentials, providerConfig.baseUrl);
  const headers = {
    "Content-Type": "application/json",
    ...(providerConfig.authHeader === "x-api-key"
      ? { "x-api-key": String(apiToken) }
      : { Authorization: `Bearer ${apiToken}` }),
  };
  const bodyObj = body as Record<string, unknown>;
  const upstreamBody = {
    model,
    prompt: (bodyObj.prompt ?? "") as string,
    ...(typeof bodyObj.duration === "number" && { duration: bodyObj.duration }),
  };
  const logRequestBody = {
    model: bodyObj.model,
    prompt:
      typeof bodyObj.prompt === "string"
        ? bodyObj.prompt.slice(0, 200)
        : String(bodyObj.prompt ?? ""),
    duration: bodyObj.duration,
  };
  log?.info?.("VIDEO", `OpenAI-compatible video generation: ${provider}/${model} -> ${endpoint}`, {
    body: logRequestBody,
  });

  const fetchResult = await fetchVideoEndpoint(endpoint, {
    headers,
    body: JSON.stringify(upstreamBody),
    log,
    signal,
    callerSignal,
    admissionSignal,
  });

  if (fetchResult.success === false) {
    return {
      success: false,
      status: fetchResult.status,
      ...(fetchResult.terminal ? { terminal: true } : {}),
      error: fetchResult.error,
    };
  }

  // Save call log for billing/tracking
  await saveCallLog({
    provider,
    model: String(bodyObj.model),
    endpoint: "video",
    status: fetchResult.status,
    durationMs: Date.now() - startTime,
    tokensIn: 0,
    tokensOut: 0,
    requestId: null,
  });

  return {
    success: true,
    data: fetchResult.data,
  };
}
