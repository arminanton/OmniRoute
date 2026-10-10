import { handleAudioSpeech } from "@omniroute/open-sse/handlers/audioSpeech.ts";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { parseSpeechModel, getSpeechProvider } from "@omniroute/open-sse/config/audioRegistry.ts";
import { resolveDynamicAudioProviders } from "@/app/api/v1/_shared/audioProviderNodes";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1AudioSpeechSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import { attachOmniRouteMetaToResponse } from "@/domain/omnirouteResponseMeta";
import { calculateModalCost } from "@/lib/usage/costCalculator";
import { generateRequestId } from "@/shared/utils/requestId";
import {
  releaseAccountRequestAfterResponseBody,
  reserveSelectedAccountRequest,
} from "@omniroute/open-sse/services/accountRequestLease.ts";
import { acquireConfiguredSharedAccountAdmission } from "@omniroute/open-sse/services/accountRequestAdmission.ts";

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
 * POST /v1/audio/speech — text-to-speech
 * OpenAI TTS API compatible. Returns audio stream.
 */
async function postHandler(request, context) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1AudioSpeechSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, validation.error.message);
  }
  const body = validation.data;
  const startTime = Date.now();

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, body.model);
  if (policy.rejection) return policy.rejection;

  // Detect a combo name and divert to full speech combo execution, mirroring
  // the images route. Checks before parseSpeechModel so a combo name is never
  // rejected as an invalid `provider/model` id — /v1/models advertises these
  // names, so refusing them here made the catalogue dishonest.
  if (body.model && typeof body.model === "string" && !body.model.includes("/")) {
    const { getComboByName } = await import("@/lib/db/combos");
    const combo = await getComboByName(body.model);
    if (combo) {
      const { executeSpeechCombo } = await import("@omniroute/open-sse/services/speechCombo");
      return executeSpeechCombo(body.model, body, startTime, request.signal);
    }
  }

  // Provider nodes eligible for speech: this route's own audio type plus general
  // chat/responses gateways. Remote hosts are opt-in (default OFF).
  const dynamicProviders = await resolveDynamicAudioProviders("/audio/speech", "audio-speech");

  const { provider, model: resolvedModel } = parseSpeechModel(body.model, dynamicProviders);
  if (!provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid speech model: ${body.model}. Use format: provider/model`
    );
  }

  // Check provider config — hardcoded first, then dynamic
  const providerConfig =
    getSpeechProvider(provider) || dynamicProviders.find((dp) => dp.id === provider) || null;
  const credentialProviderKey = providerConfig?.credentialProviderId || provider;

  // Get credentials — skip for local providers (authType: "none")
  let credentials = null;
  if (providerConfig && providerConfig.authType !== "none") {
    credentials = await getProviderCredentialsWithQuotaPreflight(
      credentialProviderKey,
      null,
      null,
      null,
      {
        reserveAccountRequest: true,
      }
    );
    if (!credentials) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
    }
    if (isAllRateLimitedCredentials(credentials)) {
      return rateLimitedProviderResponse(provider, credentials);
    }
  }

  const releaseAccountRequest = reserveSelectedAccountRequest(credentials);
  let sharedAdmission: Awaited<ReturnType<typeof acquireConfiguredSharedAccountAdmission>> = null;
  let responseOwnsReservation = false;
  const releaseReservations = () => {
    sharedAdmission?.release();
    releaseAccountRequest();
  };
  try {
    // Known Kie remote-job ownership gap: Kie creates a durable task before
    // polling and exposes no task-cancel API here, so lease loss cannot prove
    // synthesis stopped. Keep Kie out of shared hard admission.
    if (providerConfig?.format !== "kie-audio") {
      const selectedProvider =
        typeof (credentials as { provider?: unknown } | null)?.provider === "string"
          ? (credentials as { provider: string }).provider
          : credentialProviderKey;
      sharedAdmission = await acquireConfiguredSharedAccountAdmission({
        provider: selectedProvider,
        credentials,
        signal: request.signal,
      });
    }
    let response = await handleAudioSpeech({
      body,
      credentials,
      resolvedProvider: providerConfig,
      resolvedModel,
      signal: sharedAdmission?.signal ?? request.signal,
    });
    if (response?.ok) {
      await clearRecoveredProviderState(credentials);
      // TTS is billed per input character; attach cost telemetry without
      // touching the audio Content-Type / body (ADD-only headers).
      const characters = typeof body.input === "string" ? body.input.length : 0;
      const costUsd = await calculateModalCost("audio", provider, resolvedModel || body.model, {
        characters,
      });
      response = attachOmniRouteMetaToResponse(response, {
        provider,
        model: resolvedModel || body.model,
        costUsd,
        latencyMs: Date.now() - startTime,
        requestId: generateRequestId(),
      });
    }
    if (response?.ok && response.body) {
      response = releaseAccountRequestAfterResponseBody(response, releaseReservations);
      responseOwnsReservation = true;
    }
    return response;
  } catch (error) {
    const admissionError = error as { code?: string; statusCode?: number; message?: string };
    if (admissionError.code === "ACCOUNT_ADMISSION_UNAVAILABLE") {
      return errorResponse(
        admissionError.statusCode || HTTP_STATUS.SERVICE_UNAVAILABLE,
        admissionError.message || "Provider account capacity admission is unavailable"
      );
    }
    throw error;
  } finally {
    if (!responseOwnsReservation) releaseReservations();
  }
}

export const POST = withInjectionGuard(postHandler);
