import { isJsonObject } from "../../utils/kieTask.ts";
import { saveCallLog } from "@/lib/usageDb";
import { resolveAlibabaProviderMediaBaseUrl } from "@/shared/constants/alibabaProviderRegions";
import { sanitizeErrorMessage } from "../../utils/error.ts";

const DEFAULT_TASK_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 2_500;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

class DashscopeDeadlineExceeded extends Error {
  constructor(readonly phase: string) {
    super(`DashScope video ${phase} exceeded the task deadline`);
    this.name = "DashscopeDeadlineExceeded";
  }
}

function createTaskDeadline(timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  const controller = new AbortController();
  let expired = false;
  let expiryPhase = "task";

  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineAt - Date.now()),
    isExpired: () => expired,
    getExpiryPhase: () => expiryPhase,
    async run<T>(operation: () => Promise<T>, phase: string): Promise<T> {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        expired = true;
        expiryPhase = phase;
        controller.abort(new DashscopeDeadlineExceeded(phase));
        throw new DashscopeDeadlineExceeded(phase);
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            expired = true;
            expiryPhase = phase;
            const error = new DashscopeDeadlineExceeded(phase);
            controller.abort(error);
            reject(error);
          },
          Math.min(remainingMs, MAX_TIMER_DELAY_MS)
        );
      });

      try {
        return await Promise.race([Promise.resolve().then(operation), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    dispose() {
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isDeadlineError(error: unknown): error is DashscopeDeadlineExceeded {
  return error instanceof DashscopeDeadlineExceeded;
}

function responseErrorMessage(data: any, fallback: string): string {
  return String(data?.message || data?.errors?.[0]?.message || fallback);
}

/**
 * Alibaba-family video generation: create async task → poll → MP4.
 *
 * Provider identity remains authoritative for credentials and regional endpoints.
 * Bailian Coding Plan, regular Qwen Cloud, and Qwen Cloud Token Plan intentionally
 * share wire helpers only; their model lists and connections stay isolated.
 */
export async function handleDashscopeVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
}: {
  model: string;
  provider: string;
  providerConfig: {
    baseUrl: string;
    statusUrl?: string;
    models?: Array<{ id: string }>;
  };
  body: Record<string, unknown> & {
    prompt?: unknown;
    negative_prompt?: unknown;
    size?: unknown;
    aspect_ratio?: unknown;
    ratio?: unknown;
    resolution?: unknown;
    duration?: unknown;
    image?: unknown;
    image_url?: unknown;
    imageUrls?: unknown;
    image_urls?: unknown;
    reference_images?: unknown;
    media?: unknown;
    prompt_extend?: unknown;
    watermark?: unknown;
    timeout_ms?: unknown;
    poll_interval_ms?: unknown;
  };
  credentials?: {
    apiKey?: string;
    accessToken?: string;
    providerSpecificData?: unknown;
  } | null;
  log?: {
    info: (scope: string, message: string) => void;
    error: (scope: string, message: string) => void;
  } | null;
}) {
  const startTime = Date.now();
  const requestedTimeoutMs = Number(body.timeout_ms);
  const timeoutMs =
    Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.min(requestedTimeoutMs, MAX_TIMER_DELAY_MS)
      : DEFAULT_TASK_TIMEOUT_MS;
  const requestedPollIntervalMs = Number(body.poll_interval_ms);
  const pollIntervalMs =
    Number.isFinite(requestedPollIntervalMs) && requestedPollIntervalMs > 0
      ? Math.min(requestedPollIntervalMs, MAX_TIMER_DELAY_MS)
      : DEFAULT_POLL_INTERVAL_MS;
  const token = credentials?.apiKey || credentials?.accessToken;
  const isAlibabaManagedMediaProvider =
    provider === "alibaba" ||
    provider === "bailian-coding-plan" ||
    provider === "qwen-cloud" ||
    provider === "qwen-cloud-token-plan";
  const isRegisteredAlibabaMediaModel =
    !isAlibabaManagedMediaProvider ||
    providerConfig.models?.some((entry) => entry.id === model) === true;
  if (!isRegisteredAlibabaMediaModel) {
    return {
      success: false,
      status: 400,
      error: `Unsupported ${provider} video model: ${model}`,
    };
  }

  const baseUrl = (
    isAlibabaManagedMediaProvider
      ? resolveAlibabaProviderMediaBaseUrl(
          provider,
          credentials?.providerSpecificData,
          providerConfig.baseUrl
        )
      : providerConfig.baseUrl
  ).replace(/\/$/, "");
  const statusUrl = (
    isAlibabaManagedMediaProvider
      ? `${baseUrl}/tasks`
      : providerConfig.statusUrl || `${baseUrl}/tasks`
  ).replace(/\/$/, "");
  const prompt = typeof body.prompt === "string" ? body.prompt : String(body.prompt ?? "");

  if (!token) {
    return { success: false, status: 401, error: "Alibaba DashScope API key is required" };
  }

  const payload =
    provider === "qwen-cloud" || provider === "alibaba"
      ? buildAlibabaMediaPayload(provider, model, prompt, body)
      : provider === "qwen-cloud-token-plan" || provider === "bailian-coding-plan"
        ? buildHappyHorsePayload(model, prompt, body)
        : buildLegacyDashscopePayload(model, prompt, body);
  if ("error" in payload) {
    return { success: false, status: 400, error: payload.error };
  }

  if (log) {
    log.info(
      "VIDEO",
      `${provider}/${model} (dashscope-video) | prompt: "${prompt.slice(0, 60)}..."`
    );
  }

  const taskDeadline = createTaskDeadline(timeoutMs);
  let taskAccepted = false;
  try {
    // Step 1: create async task (X-DashScope-Async: enable)
    const createRes = await taskDeadline.run(
      () =>
        fetch(`${baseUrl}/services/aigc/video-generation/video-synthesis`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
          },
          body: JSON.stringify(payload),
          signal: taskDeadline.signal,
        }),
      "task submission"
    );
    let createData: any = {};
    try {
      createData = await taskDeadline.run(() => createRes.json(), "submission response handling");
    } catch (error) {
      if (isDeadlineError(error)) throw error;
      // A non-JSON create response is still an explicit HTTP rejection when
      // the provider returned a non-success status. A 2xx without a task id
      // remains ambiguous and must not trigger another generation attempt.
    }
    const taskId = createData?.output?.task_id;
    if (!taskId) {
      const errorMessage =
        createData?.message ||
        createData?.errors?.[0]?.message ||
        "DashScope video generation did not return task_id";
      if (log) {
        log.error("VIDEO", `DashScope createTask failed: ${JSON.stringify(createData)}`);
      }
      const explicitlyFailed =
        createData?.output?.task_status === "FAILED" ||
        createData?.output?.task_status === "UNKNOWN_ERROR";
      return {
        success: false,
        status: createRes.ok ? 502 : createRes.status,
        ...(!explicitlyFailed &&
        (createRes.ok || createRes.status === 408 || createRes.status >= 500)
          ? { terminal: true }
          : {}),
        error: String(errorMessage),
      };
    }
    taskAccepted = true;

    // Step 2: poll statusUrl/{task_id} until terminal
    let lastStatus = "PENDING";
    while (taskDeadline.remainingMs() > 0) {
      const sleepMs = Math.min(pollIntervalMs, taskDeadline.remainingMs());
      await taskDeadline.run(() => sleepWithSignal(sleepMs, taskDeadline.signal), "poll interval");
      if (taskDeadline.remainingMs() <= 0) {
        throw new DashscopeDeadlineExceeded("polling");
      }

      const pollRes = await taskDeadline.run(
        () =>
          fetch(`${statusUrl}/${taskId}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: taskDeadline.signal,
          }),
        "task poll"
      );
      let pollData: any;
      try {
        pollData = await taskDeadline.run(() => pollRes.json(), "poll response handling");
      } catch (error) {
        if (isDeadlineError(error)) throw error;
        return {
          success: false,
          status: 502,
          terminal: true,
          error: "DashScope accepted the video task but returned an unreadable poll response",
        };
      }

      if (!pollRes.ok) {
        return {
          success: false,
          status: pollRes.status,
          terminal: true,
          error: responseErrorMessage(
            pollData,
            `DashScope accepted the video task but polling returned HTTP ${pollRes.status}`
          ),
        };
      }
      lastStatus = pollData?.output?.task_status || "PENDING";

      if (lastStatus === "SUCCEEDED") {
        const videoUrl = pollData?.output?.video_url;
        if (!videoUrl) {
          return {
            success: false,
            status: 502,
            terminal: true,
            error: "DashScope task SUCCEEDED but no video_url",
          };
        }
        saveCallLog({
          method: "POST",
          path: "/v1/videos/generations",
          status: 200,
          model: `${provider}/${model}`,
          provider,
          duration: Date.now() - startTime,
          responseBody: { videos_count: 1 },
        }).catch(() => {});
        return {
          success: true,
          data: {
            created: Math.floor(Date.now() / 1000),
            data: [{ url: videoUrl, format: "mp4" }],
          },
        };
      }

      if (lastStatus === "FAILED" || lastStatus === "UNKNOWN_ERROR") {
        const errorMessage =
          pollData?.output?.message ||
          pollData?.output?.errors?.[0]?.message ||
          "DashScope video task FAILED";
        return { success: false, status: 502, error: String(errorMessage) };
      }
      // PENDING / RUNNING → keep polling
    }

    return {
      success: false,
      status: 504,
      terminal: true,
      error: `DashScope task ${taskId} timed out (status: ${lastStatus})`,
    };
  } catch (err: unknown) {
    const deadlineExceeded = isDeadlineError(err) || taskDeadline.isExpired();
    const deadlinePhase = isDeadlineError(err) ? err.phase : taskDeadline.getExpiryPhase();
    return {
      success: false,
      status: deadlineExceeded
        ? 504
        : isJsonObject(err) && Number.isFinite(Number(err.status))
          ? Number(err.status)
          : 502,
      // A failed create transport has an unknown acceptance outcome; every
      // failure after a task id is returned must also avoid duplicate submits.
      terminal: true,
      error: deadlineExceeded
        ? `DashScope video ${deadlinePhase} timed out${taskAccepted ? " after task acceptance" : ""}`
        : sanitizeErrorMessage(err) || "Video provider error",
    };
  } finally {
    taskDeadline.dispose();
  }
}

function buildLegacyDashscopePayload(model: string, prompt: string, body: Record<string, unknown>) {
  const sizeParam = normalizeDashscopeSize(body.size, body.aspect_ratio);
  const parameters: Record<string, unknown> = {};
  if (sizeParam) parameters.size = sizeParam;
  if (body.duration != null) parameters.duration = Number(body.duration);

  return {
    model,
    input: {
      prompt,
      ...(typeof body.negative_prompt === "string"
        ? { negative_prompt: body.negative_prompt }
        : {}),
    },
    parameters,
  };
}

function buildHappyHorsePayload(
  model: string,
  prompt: string,
  body: Record<string, unknown>
): Record<string, unknown> | { error: string } {
  const input = buildDashscopeInput(prompt, body);
  const media = collectDashscopeMedia(body);

  if (model.endsWith("-i2v")) {
    const firstFrame =
      media.find((item) => item.type === "first_frame") ||
      media.find((item) => item.type === "reference_image");
    if (!firstFrame) {
      return { error: `Image input is required for video model: ${model}` };
    }
    input.media = [{ type: "first_frame", url: firstFrame.url }];
  } else if (model.endsWith("-r2v")) {
    const referenceImages = media
      .filter((item) => item.type === "first_frame" || item.type === "reference_image")
      .map((item) => ({ type: "reference_image", url: item.url }));
    if (referenceImages.length === 0) {
      return { error: `Reference image input is required for video model: ${model}` };
    }
    input.media = referenceImages;
  }

  return {
    model,
    input,
    parameters: buildModernDashscopeParameters(body, !model.endsWith("-i2v")),
  };
}

function buildAlibabaMediaPayload(
  provider: string,
  model: string,
  prompt: string,
  body: Record<string, unknown>
): Record<string, unknown> | { error: string } {
  if (
    model === "happyhorse-1.1-i2v" ||
    model === "happyhorse-1.1-t2v" ||
    model === "happyhorse-1.1-r2v"
  ) {
    return buildHappyHorsePayload(model, prompt, body);
  }
  if (model === "happyhorse-1.0-video-edit" || model === "wan2.7-videoedit") {
    return buildModernDashscopeVideoEditPayload(model, prompt, body);
  }
  if (model === "wan2.7-t2v" || model === "wan2.7-t2v-2026-06-12") {
    return buildModernDashscopeTextToVideoPayload(model, prompt, body);
  }
  if (model === "wan2.7-i2v" || model === "wan2.7-i2v-2026-04-25" || model === "wan2.6-i2v-flash") {
    return buildModernDashscopeImageToVideoPayload(model, prompt, body);
  }
  if (model === "wan2.7-r2v-2026-06-12") {
    return buildModernDashscopeReferenceToVideoPayload(model, prompt, body);
  }
  return { error: `Unsupported ${provider} video model: ${model}` };
}

function buildModernDashscopeTextToVideoPayload(
  model: string,
  prompt: string,
  body: Record<string, unknown>
) {
  const input = buildDashscopeInput(prompt, body);
  const audio = collectDashscopeMedia(body).find((item) => item.type === "driving_audio");
  if (audio) input.audio_url = audio.url;
  return {
    model,
    input,
    parameters: buildModernDashscopeParameters(body, true),
  };
}

function buildModernDashscopeImageToVideoPayload(
  model: string,
  prompt: string,
  body: Record<string, unknown>
): Record<string, unknown> | { error: string } {
  const input = buildDashscopeInput(prompt, body);
  const media = collectDashscopeMedia(body);
  const firstFrame =
    media.find((item) => item.type === "first_frame") ||
    media.find((item) => item.type === "reference_image");
  if (!firstFrame) {
    return { error: `Image input is required for video model: ${model}` };
  }

  input.media = [
    { type: "first_frame", url: firstFrame.url },
    ...media
      .filter((item) => item.type === "last_frame" || item.type === "driving_audio")
      .map((item) => copyDashscopeMediaItem(item)),
  ];
  return {
    model,
    input,
    parameters: buildModernDashscopeParameters(body, false),
  };
}

function buildModernDashscopeReferenceToVideoPayload(
  model: string,
  prompt: string,
  body: Record<string, unknown>
): Record<string, unknown> | { error: string } {
  const input = buildDashscopeInput(prompt, body);
  const references = collectDashscopeMedia(body).flatMap((item) => {
    if (
      item.type === "first_frame" ||
      item.type === "last_frame" ||
      item.type === "reference_image"
    ) {
      return [copyDashscopeMediaItem(item, "reference_image")];
    }
    if (item.type === "video" || item.type === "first_clip" || item.type === "reference_video") {
      return [copyDashscopeMediaItem(item, "reference_video")];
    }
    return [];
  });
  if (references.length === 0) {
    return { error: `Reference image or video input is required for video model: ${model}` };
  }

  input.media = references;
  return {
    model,
    input,
    parameters: buildModernDashscopeParameters(body, true),
  };
}

function buildModernDashscopeVideoEditPayload(
  model: string,
  prompt: string,
  body: Record<string, unknown>
): Record<string, unknown> | { error: string } {
  const input = buildDashscopeInput(prompt, body);
  const media = collectDashscopeMedia(body);
  const sourceVideo = media.find(
    (item) => item.type === "video" || item.type === "first_clip" || item.type === "reference_video"
  );
  if (!sourceVideo) {
    return { error: `Video input is required for video model: ${model}` };
  }

  input.media = [
    { type: "video", url: sourceVideo.url },
    ...media
      .filter((item) => item.type === "first_frame" || item.type === "reference_image")
      .map((item) => copyDashscopeMediaItem(item, "reference_image")),
  ];
  return {
    model,
    input,
    parameters: buildModernDashscopeParameters(body, true),
  };
}

type DashscopeMediaType =
  | "first_frame"
  | "last_frame"
  | "first_clip"
  | "reference_image"
  | "reference_video"
  | "video"
  | "driving_audio";

type DashscopeMediaItem = {
  type: DashscopeMediaType;
  url: string;
  reference_voice?: string;
};

const DASHSCOPE_MEDIA_TYPES = new Set<DashscopeMediaType>([
  "first_frame",
  "last_frame",
  "first_clip",
  "reference_image",
  "reference_video",
  "video",
  "driving_audio",
]);

function buildDashscopeInput(prompt: string, body: Record<string, unknown>) {
  return {
    ...(prompt ? { prompt } : {}),
    ...(typeof body.negative_prompt === "string" && body.negative_prompt.trim()
      ? { negative_prompt: body.negative_prompt.trim() }
      : {}),
  } as Record<string, unknown>;
}

function buildModernDashscopeParameters(
  body: Record<string, unknown>,
  includeRatio: boolean
): Record<string, unknown> {
  const parameters = isJsonObject(body.parameters) ? { ...body.parameters } : {};
  const resolution = normalizeHappyHorseResolution(body.resolution, body.size);
  if (resolution) parameters.resolution = resolution;

  const ratio = normalizeHappyHorseRatio(body.ratio, body.aspect_ratio, body.size);
  if (ratio && includeRatio) parameters.ratio = ratio;
  if (body.duration != null && Number.isFinite(Number(body.duration))) {
    parameters.duration = Number(body.duration);
  }
  if (typeof body.prompt_extend === "boolean") parameters.prompt_extend = body.prompt_extend;
  if (typeof body.watermark === "boolean") parameters.watermark = body.watermark;
  if (Number.isInteger(body.seed) && Number(body.seed) >= 0) parameters.seed = Number(body.seed);
  if (typeof body.shot_type === "string" && body.shot_type.trim()) {
    parameters.shot_type = body.shot_type.trim();
  }
  return parameters;
}

function copyDashscopeMediaItem(
  item: DashscopeMediaItem,
  type: DashscopeMediaType = item.type
): DashscopeMediaItem {
  return {
    type,
    url: item.url,
    ...(item.reference_voice ? { reference_voice: item.reference_voice } : {}),
  };
}

function collectDashscopeMedia(body: Record<string, unknown>): DashscopeMediaItem[] {
  if (Array.isArray(body.media)) {
    const explicit = body.media.filter(isJsonObject).flatMap((item) => {
      const normalized = toDashscopeMediaItem(item, "reference_image");
      return normalized ? [normalized] : [];
    });
    if (explicit.length > 0) return dedupeDashscopeMedia(explicit);
  }

  const media: DashscopeMediaItem[] = [];
  const imageCandidates = [body.image, body.image_url, body.imageUrls, body.image_urls].flatMap(
    (value) => (Array.isArray(value) ? value : [value])
  );
  imageCandidates.forEach((value, index) => {
    const item = toDashscopeMediaItem(value, index === 0 ? "first_frame" : "reference_image");
    if (item) media.push(item);
  });
  addDashscopeMedia(media, body.reference_images, "reference_image");
  addDashscopeMedia(media, [body.video, body.video_url, body.videoUrls, body.video_urls], "video");
  addDashscopeMedia(media, body.reference_videos, "reference_video");
  addDashscopeMedia(media, [body.audio, body.audio_url], "driving_audio");
  return dedupeDashscopeMedia(media);
}

function addDashscopeMedia(media: DashscopeMediaItem[], value: unknown, type: DashscopeMediaType) {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values.flatMap((item) => (Array.isArray(item) ? item : [item]))) {
    const normalized = toDashscopeMediaItem(candidate, type);
    if (normalized) media.push(normalized);
  }
}

function toDashscopeMediaItem(
  value: unknown,
  fallbackType: DashscopeMediaType
): DashscopeMediaItem | null {
  if (typeof value === "string" && value.trim()) {
    return { type: fallbackType, url: value.trim() };
  }
  if (!isJsonObject(value)) return null;

  const url = [value.url, value.image_url, value.video_url, value.audio_url].find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );
  if (typeof url !== "string") return null;
  const type =
    typeof value.type === "string" && DASHSCOPE_MEDIA_TYPES.has(value.type as DashscopeMediaType)
      ? (value.type as DashscopeMediaType)
      : fallbackType;
  return {
    type,
    url: url.trim(),
    ...(typeof value.reference_voice === "string" && value.reference_voice.trim()
      ? { reference_voice: value.reference_voice.trim() }
      : {}),
  };
}

function dedupeDashscopeMedia(media: DashscopeMediaItem[]): DashscopeMediaItem[] {
  const seen = new Set<string>();
  return media.filter((item) => {
    const key = `${item.type}\0${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeHappyHorseResolution(resolution: unknown, size: unknown): string | undefined {
  if (typeof resolution === "string" && /^(720|1080)p$/i.test(resolution.trim())) {
    return resolution.trim().toUpperCase();
  }
  if (typeof size !== "string") return undefined;
  const match = size.trim().match(/^(\d+)[x*](\d+)$/i);
  if (!match) return undefined;
  return Math.max(Number(match[1]), Number(match[2])) >= 1920 ? "1080P" : "720P";
}

function normalizeHappyHorseRatio(
  ratio: unknown,
  aspectRatio: unknown,
  size: unknown
): string | undefined {
  const explicit = [ratio, aspectRatio].find(
    (value) => typeof value === "string" && /^\d+:\d+$/.test(value.trim())
  );
  if (typeof explicit === "string") return explicit.trim();
  if (typeof size !== "string") return undefined;

  const match = size.trim().match(/^(\d+)[x*](\d+)$/i);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width === height) return "1:1";
  if (width * 9 === height * 16) return "16:9";
  if (width * 16 === height * 9) return "9:16";
  if (width * 3 === height * 4) return "4:3";
  if (width * 4 === height * 3) return "3:4";
  return undefined;
}

// Map OmniRoute size/aspect_ratio → Alibaba DashScope "WxH" (1280*720).
// Accepts "1280*720", "1280x720", or a ratio "16:9". Returns undefined if unparseable
// (then omitted from the payload so DashScope applies its own default).
function normalizeDashscopeSize(size: unknown, aspectRatio: unknown): string | undefined {
  if (typeof size === "string") {
    if (/^\d+\*\d+$/.test(size)) return size;
    if (/^\d+x\d+$/.test(size)) return size.replace("x", "*");
  }
  if (typeof aspectRatio === "string") {
    const ratioMap: Record<string, string> = {
      "16:9": "1280*720",
      "9:16": "720*1280",
      "1:1": "960*960",
    };
    return ratioMap[aspectRatio];
  }
  return undefined;
}
