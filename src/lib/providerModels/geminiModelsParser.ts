/** Parse Generative Language model listings without promoting unknown actions to chat.
 * Gemini image output via generateContent remains a chat modality unless the catalog
 * explicitly declares image-only output. Imagen/Veo/embedding/rerank stay non-chat.
 */
import { getGoogleModelEndpoints } from "./googleModelEndpoints.ts";

const RETIRED_GEMINI_MODEL_IDS = new Set(["gemini-3.5-flash"]);

export interface GeminiDiscoveryModel {
  id: string;
  name: string;
  supportedEndpoints: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  description?: string;
  supportsThinking?: boolean;
  [key: string]: unknown;
}

export function parseGeminiModelsList(data: unknown): GeminiDiscoveryModel[] {
  if (!data || typeof data !== "object" || !Array.isArray((data as { models?: unknown }).models)) return [];
  const models = (data as { models: unknown[] }).models;
  return models.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const m = candidate as Record<string, unknown>;
    const raw = typeof m.name === "string" ? m.name : typeof m.id === "string" ? m.id : "";
    const id = raw.replace(/^models\//, "");
    if (!id || RETIRED_GEMINI_MODEL_IDS.has(id)) return [];
    const supportedEndpoints = getGoogleModelEndpoints(m, id);
    if (!supportedEndpoints.length) return [];
    return [{
      ...m, id, name: typeof m.displayName === "string" ? m.displayName : id,
      supportedEndpoints,
      ...(m.thinking === true ? { supportsThinking: true } : {}),
    } as GeminiDiscoveryModel];
  });
}
