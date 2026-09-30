// Allow up to five minutes for providers; multipart uploads retain the shared audio limit.
export const maxDuration = 300;
import { handleAudioTranscription } from "@omniroute/open-sse/handlers/audioTranscription.ts";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import {
  parseTranscriptionModel,
  getTranscriptionProvider,
  audioModelAliasCandidates,
  findAlternateAudioProvider,
  listAlternateAudioModelIds,
  missingAudioProviderCredentialsMessage,
  AUDIO_TRANSCRIPTION_PROVIDERS,
} from "@omniroute/open-sse/config/audioRegistry.ts";
import { resolveDynamicAudioProviders } from "@/app/api/v1/_shared/audioProviderNodes";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { attachOmniRouteMetaToResponse } from "@/domain/omnirouteResponseMeta";
import { generateRequestId } from "@/shared/utils/requestId";
import { getComboByName, getCombos } from "@/lib/db/combos";
import { getDatabaseSettings } from "@/lib/db/databaseSettings";
import { handleComboChat } from "@omniroute/open-sse/services/combo.ts";
import { log } from "@omniroute/open-sse/utils/logger.ts";
import { enforceClientApiRouteAuth } from "@/shared/utils/clientApiRouteAuth";
import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { runtimePolicyErrorResponse } from "@omniroute/open-sse/utils/error.ts";
import { runMaxaiConnectionTransport } from "@omniroute/open-sse/services/maxaiTransport.ts";
import {
  MAX_BODY_BYTES_AUDIO, readRequestBodyWithLimit, RequestBodyTooLargeError,
} from "@/shared/middleware/bodySizeGuard";

/** No generic proxy wrapper and no missing-account direct path. */
async function runMaxaiTranscriptionTransport(
  connectionId: string,
  transcribe: () => Promise<Response>,
  signal?: AbortSignal
): Promise<Response> {
  if (!connectionId?.trim()) return errorResponse(400, "MaxAI transcription requires a connection");
  try {
    signal?.throwIfAborted();
    return await runMaxaiConnectionTransport(connectionId, async () => {
      signal?.throwIfAborted();
      return transcribe();
    });
  } catch (error) {
    if (isRuntimePolicyError(error)) return runtimePolicyErrorResponse();
    return errorResponse(signal?.aborted ? 499 : 503, "MaxAI transcription unavailable");
  }
}

/**
 * Copy a multipart body, swapping only the `model` field. Combo fan-out needs one
 * body per target, and the uploaded file part is reused as-is (a Blob can be read
 * more than once).
 */
function withModel(formData: FormData, modelStr: string): FormData {
  const next = new FormData();
  for (const [key, value] of formData.entries()) {
    if (key === "model") continue;
    next.append(key, value as string | Blob);
  }
  next.set("model", modelStr);
  return next;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * Transcribe with one concrete `provider/model` string. Split out of POST so combo
 * fan-out can invoke it once per target.
 */
async function transcribeWithModel(
  formData: FormData,
  modelStr: string,
  startTime: number,
  request: Request
): Promise<Response> {
  // Combo targets must pass the same model restrictions as direct requests.
  const targetPolicy = await enforceApiKeyPolicy(request, modelStr);
  if (targetPolicy.rejection) return targetPolicy.rejection;
  // Provider nodes eligible for transcription: this route's own audio type plus
  // general chat/responses gateways. Remote hosts are opt-in (default OFF).
  const dynamicProviders = await resolveDynamicAudioProviders(
    "/audio/transcriptions",
    "audio-transcriptions"
  );

  const parsed = parseTranscriptionModel(modelStr, dynamicProviders);
  let provider = parsed.provider;
  let resolvedModel = parsed.model;
  if (!provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid transcription model: ${modelStr}. Use format: provider/model`
    );
  }

  // Check provider config — hardcoded first, then dynamic
  let providerConfig =
    getTranscriptionProvider(provider) || dynamicProviders.find((dp) => dp.id === provider) || null;

  // Get credentials — skip for local providers (authType: "none").
  // A dynamic node is addressed by its prefix but stores connections under the node
  // id, so credentials must be looked up under `credentialProviderId` when present.
  let credentials = null;
  if (providerConfig && providerConfig.authType !== "none") {
    const credentialKey = providerConfig.credentialProviderId || provider;
    // NOTE: the 2nd arg of this helper is `excludeConnectionId`, not "use this
    // connection" — a combo target's connectionId must never be passed here.
    credentials = await getProviderCredentialsWithQuotaPreflight(credentialKey);
    // Prefix match wins (`deepgram/nova-3` → native Deepgram). If that
    // provider has no credentials, retry gateways that list the same nested
    // model id (e.g. OpenRouter's `deepgram/nova-3`).
    if (!credentials && provider !== "maxai") {
      const candidates = audioModelAliasCandidates(modelStr, provider, resolvedModel);
      const alternate = findAlternateAudioProvider(
        AUDIO_TRANSCRIPTION_PROVIDERS,
        provider,
        candidates
      );
      if (alternate) {
        const alternateCredentials = await getProviderCredentialsWithQuotaPreflight(
          alternate.provider
        );
        if (alternateCredentials && !isAllRateLimitedCredentials(alternateCredentials)) {
          provider = alternate.provider;
          resolvedModel = alternate.model;
          providerConfig = alternate.config;
          credentials = alternateCredentials;
        }
      }
    }
    if (!credentials) {
      const candidates = audioModelAliasCandidates(modelStr, provider, resolvedModel);
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        missingAudioProviderCredentialsMessage(
          provider,
          listAlternateAudioModelIds(AUDIO_TRANSCRIPTION_PROVIDERS, provider, candidates)
        )
      );
    }
    if (isAllRateLimitedCredentials(credentials)) {
      return rateLimitedProviderResponse(provider, credentials);
    }
  }

  const transcribe = () => handleAudioTranscription({
    formData,
    credentials,
    resolvedProvider: providerConfig,
    resolvedModel,
    signal: request.signal,
  });
  let response = provider === "maxai"
    ? await runMaxaiTranscriptionTransport(credentials?.connectionId, transcribe, request.signal)
    : await transcribe();
  if (response?.ok) {
    await clearRecoveredProviderState(credentials);
    // No text body / playback duration available from the multipart upload, so
    // per-second pricing cannot be applied → cost 0 (ADD-only headers, body intact).
    response = attachOmniRouteMetaToResponse(response, {
      provider,
      model: resolvedModel,
      costUsd: 0,
      latencyMs: Date.now() - startTime,
      requestId: generateRequestId(),
    });
  }
  return response;
}

/**
 * POST /v1/audio/transcriptions — transcribe audio files
 * OpenAI Whisper API compatible (multipart/form-data)
 */
export async function POST(request: Request) {
  const authRejection = await enforceClientApiRouteAuth(request);
  if (authRejection) return authRejection;
  let formData: FormData;
  try {
    const bytes = await readRequestBodyWithLimit(request, MAX_BODY_BYTES_AUDIO);
    request.signal.throwIfAborted();
    formData = await new Response(bytes, {
      headers: { "Content-Type": request.headers.get("content-type") || "" },
    }).formData();
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return errorResponse(413, "Audio upload exceeds the audio limit");
    if (request.signal.aborted) return errorResponse(499, "Transcription request aborted");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const startTime = Date.now();

  const model = formData.get("model");
  if (!model) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }
  const modelStr = String(model);

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, modelStr);
  if (policy.rejection) return policy.rejection;

  // A bare name (no "/") may be a combo. /v1/models advertises combos, and chat and
  // embeddings both resolve them — resolving here too keeps the catalog honest and
  // frees callers from hardcoding a provider's internal model id.
  if (!modelStr.includes("/")) {
    try {
      const combo = await getComboByName(modelStr);
      if (combo) {
        let allCombos: Awaited<ReturnType<typeof getCombos>> = [];
        try {
          allCombos = await getCombos();
        } catch {}
        let settings = {};
        try {
          settings = getDatabaseSettings();
        } catch {}

        return handleComboChat({
          body: { model: modelStr } as any,
          combo: combo as any,
          handleSingleModel: async (_reqBody: any, targetModelStr: string) =>
            transcribeWithModel(withModel(formData, targetModelStr), targetModelStr, startTime, request),
          isModelAvailable: undefined,
          log,
          settings,
          allCombos: allCombos as any,
          relayOptions: undefined,
          signal: request.signal,
        } as any);
      }
    } catch (err) {
      log.error("AUDIO", `Combo resolution failed for ${modelStr}: ${err}`);
    }
  }

  return transcribeWithModel(formData, modelStr, startTime, request);
}
