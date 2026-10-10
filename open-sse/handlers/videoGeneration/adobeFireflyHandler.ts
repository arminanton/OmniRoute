// Adobe Firefly (unofficial) video-generation handler.
// Family: adobe-firefly-video | Provider: adobe-firefly
//
// Credentials: IMS access_token (JWT) or full Cookie header from
// firefly.adobe.com / new.express.adobe.com.

import { saveCallLog } from "@/lib/usageDb";
import { sanitizeErrorMessage } from "../../utils/error.ts";
import {
  RemoteMediaFetchError,
  createRemoteMediaFailureResult,
} from "@/shared/network/remoteImageFetch";
import {
  AdobeFireflyError,
  adobeFireflyGenerateVideo,
  resolveAdobeSourceImageIds,
  resolveAdobeVideoModel,
} from "../../services/adobeFireflyClient.ts";
import { ensureAdobeFireflySession } from "../../services/adobeFireflySession.ts";

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_VIDEO_TIMEOUT_MS = 300_000;
const MAX_VIDEO_TIMEOUT_MS = 10 * 60_000;

/** Keep fetch, response-body reads, submit retries and polling inside one deadline. */
function createDeadlineFetch(
  fetchImpl: typeof fetch,
  deadlineSignal: AbortSignal,
  deadline: Promise<never>,
  onSubmitDispatch: () => void,
  onSubmitResponse: (response: Response) => void,
  onSubmitTransportError: () => void
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const method = String(init?.method || request?.method || "GET").toUpperCase();
    const url = String(request?.url || input);
    const isVideoSubmit = method === "POST" && url.includes("/v2/3p-videos/generate-async");
    if (deadlineSignal.aborted) {
      throw deadlineSignal.reason;
    }
    if (isVideoSubmit) onSubmitDispatch();

    const originalSignal = init?.signal || request?.signal;
    const signal = originalSignal
      ? AbortSignal.any([originalSignal, deadlineSignal])
      : deadlineSignal;
    let response: Response;
    try {
      response = await Promise.race([fetchImpl(input, { ...init, signal }), deadline]);
    } catch (error) {
      if (isVideoSubmit) onSubmitTransportError();
      throw error;
    }
    if (isVideoSubmit) onSubmitResponse(response);

    // Fetch resolving at headers is not enough: json()/text() may hang while a
    // remote generation is already accepted. Bound body reads by this deadline too.
    return new Proxy(response, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (
          typeof property === "string" &&
          ["json", "text", "arrayBuffer", "blob", "formData"].includes(property) &&
          typeof value === "function"
        ) {
          return (...args: unknown[]) =>
            Promise.race([Promise.resolve(value.apply(target, args)), deadline]);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Response;
  }) as typeof fetch;
}

export async function handleAdobeFireflyVideoGeneration({
  model,
  provider,
  body,
  credentials,
  log,
  signal,
  fetchImpl = fetch,
}: {
  model: string;
  provider: string;
  providerConfig?: { baseUrl?: string };
  body: Record<string, unknown>;
  credentials?: {
    apiKey?: string;
    accessToken?: string;
    connectionId?: string;
    providerSpecificData?: {
      cookie?: unknown;
      access_token?: unknown;
      accessToken?: unknown;
      browserSessionKey?: unknown;
    } | null;
  } | null;
  log?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}) {
  const startTime = Date.now();
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return {
      success: false,
      status: 400,
      error: "Prompt is required for Adobe Firefly video generation",
    };
  }

  const timeoutMs = Math.max(
    1,
    Math.min(
      MAX_VIDEO_TIMEOUT_MS,
      Math.floor(normalizePositiveNumber(body.timeout_ms, DEFAULT_VIDEO_TIMEOUT_MS))
    )
  );
  const deadlineError = new AdobeFireflyError(
    "Adobe Firefly video generation exceeded the task deadline",
    504,
    "timeout"
  );
  const deadlineController = new AbortController();
  let deadlineExpired = false;
  let submitInFlight = false;
  let ambiguousSubmit = false;
  let taskAccepted = false;
  let rejectDeadline!: (reason: unknown) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const deadlineTimer = setTimeout(() => {
    deadlineExpired = true;
    if (submitInFlight) ambiguousSubmit = true;
    deadlineController.abort(deadlineError);
    rejectDeadline(deadlineError);
  }, timeoutMs);
  deadlineTimer.unref?.();
  const deadlineFetch = createDeadlineFetch(
    fetchImpl,
    deadlineController.signal,
    deadline,
    () => {
      signal?.throwIfAborted();
      submitInFlight = true;
    },
    (response) => {
      submitInFlight = false;
      if (response.ok) taskAccepted = true;
      else if (response.status === 408 || response.status >= 500) ambiguousSubmit = true;
    },
    () => {
      submitInFlight = false;
      ambiguousSubmit = true;
    }
  );
  const callerCancelled = () => {
    const message = "Video generation request cancelled";
    const terminal = taskAccepted || ambiguousSubmit;
    log?.info?.("VIDEO", `${provider}/${model} adobe-firefly cancelled by caller`);
    saveCallLog({
      method: "POST",
      path: "/v1/videos/generations",
      status: 499,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: message,
    }).catch(() => {});
    return {
      success: false as const,
      status: 499,
      ...(terminal ? { terminal: true as const } : {}),
      error: message,
    };
  };

  try {
    signal?.throwIfAborted();
    const session = await Promise.race([
      ensureAdobeFireflySession({ credentials, fetchImpl: deadlineFetch, log }),
      deadline,
    ]);
    const accessToken = session.accessToken;
    const sessionCookie = session.cookie || undefined;
    const arpSessionId = session.arpSessionId;
    const seed =
      typeof body.seed === "number"
        ? body.seed
        : typeof body.seed === "string" && String(body.seed).trim()
          ? Number(body.seed)
          : undefined;

    // Kling i2v / Veo ref / Sora frame: upload reference images first.
    const { id: videoModelId } = resolveAdobeVideoModel(String(model));
    const maxFrames = videoModelId.includes("kling") || videoModelId.includes("sora") ? 2 : 3;
    const sourceSignal = signal
      ? AbortSignal.any([signal, deadlineController.signal])
      : deadlineController.signal;
    const sourceImageIds = await Promise.race([
      resolveAdobeSourceImageIds({
        accessToken,
        body,
        max: maxFrames,
        sessionCookie,
        arpSessionId,
        prompt,
        signal: sourceSignal,
        fetchImpl: deadlineFetch,
        log,
      }),
      deadline,
    ]);
    signal?.throwIfAborted();

    log?.info?.(
      "VIDEO",
      `${provider}/${model} (adobe-firefly) | prompt: "${prompt.slice(0, 60)}${prompt.length > 60 ? "..." : ""}"` +
        (sourceImageIds.length ? ` | frames: ${sourceImageIds.length}` : "") +
        ` | session=${session.source}`
    );

    const resultPromise = adobeFireflyGenerateVideo({
      accessToken,
      prompt,
      model,
      size: body.size,
      aspectRatio: body.aspect_ratio ?? body.aspectRatio ?? body.ratio ?? body.size,
      duration: body.duration ?? body.durationSeconds,
      quality: body.quality,
      resolution: body.resolution ?? body.quality,
      seed: Number.isFinite(seed as number) ? (seed as number) : undefined,
      negativePrompt:
        typeof body.negative_prompt === "string"
          ? body.negative_prompt
          : typeof body.negativePrompt === "string"
            ? body.negativePrompt
            : undefined,
      generateAudio: body.generate_audio !== false && body.generateAudio !== false,
      sourceImageIds: sourceImageIds.length ? sourceImageIds : undefined,
      sessionCookie,
      arpSessionId,
      sessionFingerprint: session.fingerprint,
      sessionBrowserKey: session.browserSessionKey,
      timeoutMs,
      fetchImpl: deadlineFetch,
      log,
    });
    const result = await Promise.race([resultPromise, deadline]);

    // Caller cancellation does not cancel a dispatched/accepted Adobe job. Let it
    // settle, then report 499 so the disconnected request is not recorded as success.
    if (signal?.aborted) {
      taskAccepted = true;
      return callerCancelled();
    }

    saveCallLog({
      method: "POST",
      path: "/v1/videos/generations",
      status: 200,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
    }).catch(() => {});

    return {
      success: true,
      data: {
        created: Math.floor(Date.now() / 1000),
        data: [{ url: result.url, format: result.format || "mp4" }],
      },
    };
  } catch (err) {
    if (err instanceof RemoteMediaFetchError) {
      // The local result-provenance brand is what prevents combo replay for a
      // remote-media boundary failure. Spreading this value would drop that
      // private marker and could incorrectly launch another paid video job.
      return createRemoteMediaFailureResult(err, signal);
    }
    if (signal?.aborted) {
      return callerCancelled();
    }
    if (err instanceof AdobeFireflyError) {
      const status = deadlineExpired ? 504 : err.status;
      const message = deadlineExpired ? deadlineError.message : err.message;
      log?.error?.("VIDEO", `${provider} adobe-firefly error ${status}: ${message}`);
      saveCallLog({
        method: "POST",
        path: "/v1/videos/generations",
        status,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error: message.slice(0, 500),
      }).catch(() => {});
      const terminal = (taskAccepted || ambiguousSubmit) && err.code !== "job_failed";
      return {
        success: false,
        status,
        ...(terminal ? { terminal: true } : {}),
        error: message,
      };
    }
    const errorText = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    log?.error?.("VIDEO", `${provider} adobe-firefly exception: ${errorText}`);
    const status = deadlineExpired ? 504 : 500;
    saveCallLog({
      method: "POST",
      path: "/v1/videos/generations",
      status,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: errorText.slice(0, 500),
    }).catch(() => {});
    return {
      success: false,
      status,
      ...(taskAccepted || ambiguousSubmit ? { terminal: true } : {}),
      error: errorText,
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}
