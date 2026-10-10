// Auto-extracted from open-sse/handlers/imageGeneration.ts in PR-#4582-batch
// Family: comfyui | Module: comfyUI | Lines: 3213-3314 (102 LOC)
// Ref: see open-sse/handlers/imageGeneration.ts top-of-file comment for split rationale

import { randomUUID } from "crypto";
import { saveCallLog } from "@/lib/usageDb";
import { sanitizeErrorMessage } from "../../../utils/error.ts";
import {
  ComfyWorkflowSubmitError,
  submitComfyWorkflow,
  pollComfyResult,
  fetchComfyOutput,
  extractComfyOutputFiles,
} from "../../../utils/comfyuiClient.ts";

export async function handleComfyUIImageGeneration({
  model,
  provider,
  providerConfig,
  body,
  log,
  signal,
}) {
  const startTime = Date.now();
  const [width, height] = (body.size || "1024x1024").split("x").map(Number);
  let promptAccepted = false;

  // Default txt2img workflow template for ComfyUI
  const workflow = {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: parseInt(randomUUID().replace(/-/g, "").substring(0, 8), 16) % 2 ** 32,
        steps: body.steps || 20,
        cfg: body.cfg_scale || 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: model },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: width || 1024, height: height || 1024, batch_size: body.n || 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: body.prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: body.negative_prompt || "", clip: ["4", 1] },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "omniroute", images: ["8", 0] },
    },
  };

  if (log) {
    const promptPreview = String(body.prompt ?? "").slice(0, 60);
    log.info("IMAGE", `${provider}/${model} (comfyui) | prompt: "${promptPreview}..."`);
  }

  try {
    const promptId = await submitComfyWorkflow(providerConfig.baseUrl, workflow, signal);
    promptAccepted = true;
    const historyEntry = await pollComfyResult(providerConfig.baseUrl, promptId);
    // A ComfyUI interrupt is global rather than prompt-scoped, so keep polling
    // an accepted job to completion. Once it settles, cancellation can safely
    // skip the artifact download.
    if (signal?.aborted) {
      const error = "Image generation request cancelled";
      saveCallLog({
        method: "POST",
        path: "/v1/images/generations",
        status: 499,
        model: `${provider}/${model}`,
        provider,
        duration: Date.now() - startTime,
        error,
      }).catch(() => {});
      return { success: false, status: 499, terminal: true, error };
    }
    const outputFiles = extractComfyOutputFiles(historyEntry);

    const images = [];
    for (const file of outputFiles) {
      const buffer = await fetchComfyOutput(
        providerConfig.baseUrl,
        file.filename,
        file.subfolder,
        file.type,
        signal
      );
      const base64 = Buffer.from(buffer).toString("base64");
      images.push({ b64_json: base64, revised_prompt: body.prompt });
    }

    saveCallLog({
      method: "POST",
      path: "/v1/images/generations",
      status: 200,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      responseBody: { images_count: images.length },
    }).catch(() => {});

    return {
      success: true,
      data: { created: Math.floor(Date.now() / 1000), data: images },
    };
  } catch (err) {
    if (log) log.error("IMAGE", `${provider} comfyui error: ${err.message}`);
    const cancelled = signal?.aborted;
    const status = cancelled ? 499 : 502;
    const terminal =
      promptAccepted || (err instanceof ComfyWorkflowSubmitError && err.terminal) || cancelled;
    saveCallLog({
      method: "POST",
      path: "/v1/images/generations",
      status,
      model: `${provider}/${model}`,
      provider,
      duration: Date.now() - startTime,
      error: err.message,
    }).catch(() => {});
    return {
      success: false,
      status,
      ...(terminal ? { terminal: true } : {}),
      error: cancelled
        ? "Image generation request cancelled"
        : `Image provider error: ${sanitizeErrorMessage((err as Error).message || err)}`,
    };
  }
}
