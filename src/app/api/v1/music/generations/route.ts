import { handleMusicGeneration } from "@omniroute/open-sse/handlers/musicGeneration.ts";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { parseMusicModel, getMusicProvider } from "@omniroute/open-sse/config/musicRegistry.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import {
  failedMediaGenerationResponse,
  mediaGenerationOptionsResponse,
  promptRequiredResponse,
  readMediaGenerationBody,
  successfulMediaGenerationResponse,
} from "@/app/api/v1/_shared/mediaGenerationRoute";
import { getSpecialtyModelsResponse } from "@/app/api/v1/_shared/specialtyCatalog";
import { reserveSelectedAccountRequest } from "@omniroute/open-sse/services/accountRequestLease.ts";
import {
  acquireConfiguredSharedAccountAdmission,
  getAccountAdmissionAbortStatus,
} from "@omniroute/open-sse/services/accountRequestAdmission.ts";

export const dynamic = "force-dynamic";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return mediaGenerationOptionsResponse();
}

/**
 * GET /v1/music/generations — list available music models
 */
export async function GET(request?: Request) {
  return getSpecialtyModelsResponse(
    request,
    "/v1/music/generations",
    (model) => model.type === "music"
  );
}

/**
 * #6928: best-effort per-connection base-URL override lookup for local no-auth
 * media providers (ComfyUI). Returns null instead of failing when no connection
 * exists — local providers must keep working with zero configuration.
 */
async function resolveLocalOverrideCredentials(provider) {
  const localCredentials = await getProviderCredentialsWithQuotaPreflight(
    provider,
    null,
    null,
    null,
    {
      reserveAccountRequest: true,
    }
  );
  return localCredentials && !isAllRateLimitedCredentials(localCredentials)
    ? localCredentials
    : null;
}

/**
 * POST /v1/music/generations — generate music
 */
async function postHandler(request, context) {
  if (request.signal.aborted) {
    return errorResponse(499, "Music generation request cancelled");
  }

  const parsed = await readMediaGenerationBody(request, log, "MUSIC");
  if (parsed.state === "invalid") {
    if (request.signal.aborted) {
      return errorResponse(499, "Music generation request cancelled");
    }
    return parsed.response;
  }
  const body = parsed.body;
  const startTime = Date.now();

  const promptError = promptRequiredResponse(body);
  if (promptError) return promptError;

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, body.model);
  if (request.signal.aborted) {
    return errorResponse(499, "Music generation request cancelled");
  }
  if (policy.rejection) return policy.rejection;

  // Parse model to get provider
  const { provider } = parseMusicModel(body.model);
  if (!provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid music model: ${body.model}. Use format: provider/model`
    );
  }

  // Check provider config for auth bypass
  const providerConfig = getMusicProvider(provider);

  // Get credentials — skip for local providers (authType: "none")
  let credentials = null;
  if (providerConfig && providerConfig.authType !== "none") {
    credentials = await getProviderCredentialsWithQuotaPreflight(provider, null, null, null, {
      reserveAccountRequest: true,
    });
    if (!credentials) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials for music provider: ${provider}`
      );
    }
    if (isAllRateLimitedCredentials(credentials)) {
      return rateLimitedProviderResponse(provider, credentials);
    }
  } else if (providerConfig?.authType === "none") {
    credentials = await resolveLocalOverrideCredentials(provider);
  }

  const releaseAccountRequest = reserveSelectedAccountRequest(credentials);
  let sharedAdmission: Awaited<ReturnType<typeof acquireConfiguredSharedAccountAdmission>> = null;
  let result;
  try {
    if (request.signal.aborted) {
      return errorResponse(499, "Music generation request cancelled");
    }

    // Use the request signal to cancel a queued admission, then detach it after
    // acquisition. A remote task may already have been accepted and cannot
    // necessarily be cancelled; its account capacity must remain held while we
    // poll that task to a terminal state or timeout. The admission lease itself
    // remains a separate signal so lease loss can still fence cancellable work
    // before a provider accepts a background task.
    const admissionWaitController = new AbortController();
    const abortAdmissionWait = () => admissionWaitController.abort(request.signal.reason);
    request.signal.addEventListener("abort", abortAdmissionWait, { once: true });
    try {
      const selectedProvider =
        typeof credentials?.provider === "string" ? credentials.provider : provider;
      sharedAdmission = await acquireConfiguredSharedAccountAdmission({
        provider: selectedProvider,
        credentials,
        signal: admissionWaitController.signal,
      });
    } catch (error) {
      const admissionError = error as {
        code?: string;
        statusCode?: number;
        message?: string;
      };
      if (admissionError.code === "ACCOUNT_ADMISSION_UNAVAILABLE") {
        const status = getAccountAdmissionAbortStatus(request.signal) ?? 503;
        return errorResponse(
          status,
          status === 499
            ? "Music generation request cancelled"
            : admissionError.message || "Provider account capacity admission is unavailable"
        );
      }
      throw error;
    } finally {
      request.signal.removeEventListener("abort", abortAdmissionWait);
    }

    if (request.signal.aborted) {
      return errorResponse(499, "Music generation request cancelled");
    }

    const upstreamSignal = sharedAdmission
      ? AbortSignal.any([request.signal, sharedAdmission.signal])
      : request.signal;
    try {
      result = await handleMusicGeneration({
        body,
        credentials,
        log,
        signal: upstreamSignal,
        // Current music providers expose no cancellation API for accepted jobs.
        // Keep polling with no abort signal after a task ID is known, retaining
        // both account reservations through terminal completion/timeout. The
        // route reports 499/503 after that lifecycle settles.
        pollSignal: null,
      });
    } catch (error) {
      const abortStatus = getAccountAdmissionAbortStatus(request.signal, sharedAdmission?.signal);
      if (abortStatus) {
        return errorResponse(
          abortStatus,
          abortStatus === 499
            ? "Music generation request cancelled"
            : "Provider account capacity lease lost"
        );
      }
      throw error;
    }
  } finally {
    sharedAdmission?.release();
    releaseAccountRequest();
  }

  const abortStatus = getAccountAdmissionAbortStatus(request.signal, sharedAdmission?.signal);
  if (abortStatus) {
    return errorResponse(
      abortStatus,
      abortStatus === 499
        ? "Music generation request cancelled"
        : "Provider account capacity lease lost"
    );
  }

  if (result.success) {
    await clearRecoveredProviderState(credentials);
    return successfulMediaGenerationResponse({
      result,
      billingMode: "audio",
      provider,
      model: body.model,
      startTime,
      duration: body.duration,
    });
  }

  return failedMediaGenerationResponse(result, "Music generation provider error");
}

export const POST = withInjectionGuard(postHandler);
