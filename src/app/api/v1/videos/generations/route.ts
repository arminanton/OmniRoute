import {
  handleVideoGeneration,
  isCancellableDirectVideoTarget,
} from "@omniroute/open-sse/handlers/videoGeneration.ts";
import { resolveVideoCredentialProvider } from "@omniroute/open-sse/handlers/videoGeneration/googleFlow.ts";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import {
  getProviderCredentialsWithQuotaPreflight,
  clearRecoveredProviderState,
} from "@/sse/services/auth";
import { getVideoProvider } from "@omniroute/open-sse/config/videoRegistry.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { getApiKeyRequestScope } from "@/app/api/v1/_helpers/apiKeyScope";
import { CORS_HEADERS } from "@/shared/utils/cors";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
} from "@/app/api/v1/_shared/rateLimit";
import {
  failedMediaGenerationResponse,
  isMediaGenerationFailure,
  mediaGenerationOptionsResponse,
  promptRequiredResponse,
  readMediaGenerationBody,
  successfulMediaGenerationResponse,
} from "@/app/api/v1/_shared/mediaGenerationRoute";
import type { MediaGenerationResultLike } from "@/app/api/v1/_shared/mediaGenerationRoute";
import { getSpecialtyModelsResponse } from "@/app/api/v1/_shared/specialtyCatalog";
import { reserveSelectedAccountRequest } from "@omniroute/open-sse/services/accountRequestLease.ts";
import { acquireConfiguredSharedAccountAdmission } from "@omniroute/open-sse/services/accountRequestAdmission.ts";
import {
  isVideoPromptOptional,
  resolveLocalOverrideCredentials,
  resolveVideoModelTarget,
} from "@/app/api/v1/_shared/videoModelResolution";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DurableAgnesTaskService = typeof import("@/app/api/v1/_shared/durableAgnesVideoTasks");
type DurableAgnesTask = NonNullable<
  Awaited<ReturnType<DurableAgnesTaskService["getDurableAgnesVideoTask"]>>
>;
type DurableAgnesTaskIdentity = ReturnType<DurableAgnesTaskService["makeDurableAgnesTaskIdentity"]>;

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return mediaGenerationOptionsResponse();
}

/**
 * GET /v1/videos/generations — list available video models
 */
export async function GET(request?: Request) {
  return getSpecialtyModelsResponse(
    request,
    "/v1/videos/generations",
    (model) => model.type === "video"
  );
}

function prefersAsyncVideo(request: Request): boolean {
  return (request.headers.get("prefer") ?? "")
    .split(",")
    .some(
      (preference) => preference.trim().split(";")[0]?.trim().toLowerCase() === "respond-async"
    );
}

function durableTaskResponse(service: DurableAgnesTaskService, task: DurableAgnesTask) {
  const status = service.durableAgnesTaskHttpStatus(task);
  const statusUrl = `/api/v1/videos/tasks/${encodeURIComponent(task.id)}`;
  return new Response(JSON.stringify(service.toDurableAgnesTaskResponse(task)), {
    status,
    headers: {
      "Content-Type": "application/json",
      Location: statusUrl,
      ...CORS_HEADERS,
      ...(status === 202
        ? { "Retry-After": String(service.durableAgnesTaskRetryAfterSeconds(task)) }
        : {}),
      "Access-Control-Expose-Headers": "Location, Retry-After",
    },
  });
}

/**
 * POST /v1/videos/generations — generate videos
 */
async function postHandler(request, context) {
  const parsed = await readMediaGenerationBody(request, log, "VIDEO");
  if (parsed.state === "invalid") {
    return parsed.response;
  }
  const body = parsed.body;
  const startTime = Date.now();
  const wantsAsync = prefersAsyncVideo(request);

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, body.model);
  if (policy.rejection) return policy.rejection;

  // Detect a combo name and divert to full video combo execution, mirroring
  // the images route. Checks before the provider lookup — and before the
  // prompt-required check below — so a combo name is never rejected as an
  // invalid `provider/model` id or against the wrong model's prompt rules:
  // /v1/models advertises these names, and prompt requirements depend on the
  // resolved target, which for a combo is only known after expansion.
  if (body.model && typeof body.model === "string" && !body.model.includes("/")) {
    const { getComboByName } = await import("@/lib/db/combos");
    const combo = await getComboByName(body.model);
    if (combo) {
      if (wantsAsync) {
        return errorResponse(
          HTTP_STATUS.BAD_REQUEST,
          "Asynchronous video tasks currently support direct Agnes models only"
        );
      }
      const { executeVideoCombo } = await import("@omniroute/open-sse/services/videoCombo");
      return executeVideoCombo(body.model, body, { request, policy }, startTime, log);
    }
  }

  // Parse model to get provider — checks the built-in registry, then custom
  // OpenAI-compatible provider nodes tagged with the "videos" endpoint.
  const resolvedTarget = await resolveVideoModelTarget(body.model);
  const { provider, model: requestedModel, isCustomModel } = resolvedTarget;
  if (!provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid video model: ${body.model}. Use format: provider/model`
    );
  }

  if (!isVideoPromptOptional(resolvedTarget)) {
    const promptError = promptRequiredResponse(body);
    if (promptError) return promptError;
  }

  let durableTaskService: DurableAgnesTaskService | null = null;
  let durableTaskIdentity: DurableAgnesTaskIdentity | null = null;
  if (wantsAsync) {
    const configuredModels = getVideoProvider(provider)?.models ?? [];
    if (
      provider !== "agnes" ||
      getVideoProvider(provider)?.format !== "agnes-video-job" ||
      !configuredModels.some((candidate) => candidate.id === requestedModel)
    ) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        "Asynchronous video tasks currently support direct Agnes Video V2.0 requests only"
      );
    }
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        "Idempotency-Key is required for async video requests"
      );
    }
    const directlyPresentedScope = await getApiKeyRequestScope(request, {
      requireAuthenticated: true,
      allowUrl: false,
      allowClientApiKeyHeader: true,
    });
    if (directlyPresentedScope.rejection) return directlyPresentedScope.rejection;
    const directlyPresentedApiKey = directlyPresentedScope.apiKey;
    if (
      !policy.apiKeyInfo?.id ||
      policy.apiKeyInfo.id === "env-key" ||
      !directlyPresentedApiKey ||
      directlyPresentedScope.apiKeyId !== policy.apiKeyInfo.id ||
      policy.apiKey !== directlyPresentedApiKey
    ) {
      return errorResponse(
        HTTP_STATUS.UNAUTHORIZED,
        "Async video tasks require a directly presented registered API key"
      );
    }
    try {
      durableTaskService = await import("@/app/api/v1/_shared/durableAgnesVideoTasks");
      durableTaskIdentity = durableTaskService.makeDurableAgnesTaskIdentity({
        apiKeyId: policy.apiKeyInfo.id,
        apiKey: directlyPresentedApiKey,
        idempotencyKey,
        model: requestedModel,
        body,
      });
      const existing = await durableTaskService.findDurableAgnesVideoTask(durableTaskIdentity);
      if (existing) return durableTaskResponse(durableTaskService, existing);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "invalid_idempotency_key") {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, "Idempotency-Key is invalid");
      }
      if (message === "idempotency_key_conflict") {
        return errorResponse(409, "Idempotency-Key was already used for a different request");
      }
      log.error("VIDEO", "Durable Agnes task store is unavailable");
      return errorResponse(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        "Durable async video tasks are unavailable"
      );
    }
  }

  // Check provider config for auth bypass
  const providerConfig = getVideoProvider(provider);

  // Get credentials — skip for local providers (authType: "none").
  // Google Flow has no standalone connection: it reuses the Antigravity Google
  // OAuth credential (resolveVideoCredentialProvider maps googleflow → antigravity).
  let credentials = null;
  if (providerConfig && providerConfig.authType !== "none") {
    credentials = await getProviderCredentialsWithQuotaPreflight(
      resolveVideoCredentialProvider(provider),
      null,
      null,
      requestedModel,
      { reserveAccountRequest: true }
    );
    if (!credentials) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials for video provider: ${provider}`
      );
    }
    if (isAllRateLimitedCredentials(credentials)) {
      return rateLimitedProviderResponse(provider, credentials);
    }
  } else if (isCustomModel) {
    credentials = await getProviderCredentialsWithQuotaPreflight(
      provider,
      null,
      null,
      requestedModel,
      { reserveAccountRequest: true }
    );
    if (!credentials) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials for custom video provider: ${provider}`
      );
    }
    if (isAllRateLimitedCredentials(credentials)) {
      return rateLimitedProviderResponse(provider, credentials);
    }
  } else if (providerConfig?.authType === "none") {
    credentials = await resolveLocalOverrideCredentials(provider);
  }

  const releaseAccountRequest = reserveSelectedAccountRequest(credentials);
  if (wantsAsync && durableTaskService && durableTaskIdentity) {
    try {
      const outcome = await durableTaskService.submitDurableAgnesVideoTask({
        identity: durableTaskIdentity,
        body,
        credentials,
        signal: request.signal,
      });
      if (outcome.kind === "task") return durableTaskResponse(durableTaskService, outcome.task);
      if (outcome.kind === "capacity_unavailable") {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "No provider account capacity is currently available for an async video task",
              type: "rate_limit_error",
              code: outcome.reason,
            },
          }),
          {
            status: outcome.status,
            headers: {
              "Content-Type": "application/json",
              ...CORS_HEADERS,
              "Retry-After": "5",
            },
          }
        );
      }
      return errorResponse(outcome.status, "Agnes rejected the asynchronous video task submission");
    } catch (error) {
      if (error instanceof Error && error.message === "idempotency_key_conflict") {
        return errorResponse(409, "Idempotency-Key was already used for a different request");
      }
      log.error(
        "VIDEO",
        "Durable Agnes task submission failed; submission state is retained safely"
      );
      return errorResponse(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        "Async video task submission state is unavailable; do not retry with a new idempotency key"
      );
    } finally {
      releaseAccountRequest();
    }
  }

  let sharedAdmission: Awaited<ReturnType<typeof acquireConfiguredSharedAccountAdmission>> = null;
  let result: MediaGenerationResultLike;
  try {
    const isDirectCancellable = await isCancellableDirectVideoTarget(
      provider,
      requestedModel,
      isCustomModel
    );
    if (isDirectCancellable) {
      try {
        sharedAdmission = await acquireConfiguredSharedAccountAdmission({
          provider: resolveVideoCredentialProvider(provider),
          credentials,
          signal: request.signal,
        });
      } catch (error) {
        const admissionError = error as { statusCode?: number; message?: string };
        return errorResponse(
          admissionError.statusCode === 499 ? 499 : HTTP_STATUS.SERVICE_UNAVAILABLE,
          admissionError.message || "Provider account capacity admission is unavailable"
        );
      }
    }

    if (request.signal.aborted) {
      return errorResponse(499, "Request cancelled by caller");
    }

    result = await handleVideoGeneration({
      body,
      credentials,
      log,
      signal: sharedAdmission?.signal ?? request.signal,
      callerSignal: request.signal,
      admissionSignal: sharedAdmission?.signal,
      ...(isCustomModel && { resolvedProvider: provider }),
    });
  } finally {
    sharedAdmission?.release();
    releaseAccountRequest();
  }

  if (isMediaGenerationFailure(result)) {
    return failedMediaGenerationResponse(result, "Video generation provider error");
  }

  await clearRecoveredProviderState(credentials);
  return successfulMediaGenerationResponse({
    result: { data: result.data },
    billingMode: "video",
    provider,
    model: body.model,
    startTime,
    duration: body.duration,
  });
}

export const POST = withInjectionGuard(postHandler);
