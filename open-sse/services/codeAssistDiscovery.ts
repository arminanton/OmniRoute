/** Account-advertised Cloud Code model metadata, not public Gemini API defaults.
 * Field names verified against agy1.2.16 ModelDetails protobuf descriptor.
 */
import { z } from "zod";

export type CodeAssistDiscoveredModel = {
  id: string;
  name: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  isInternal?: boolean;
  disabled?: boolean;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  supportsAdaptiveThinking?: boolean;
  supportsVideo?: boolean;
  supportsPdf?: boolean;
  supportedMimeTypes?: Record<string, boolean>;
  discoveryRoles?: string[];
};

const unknownRecordSchema = z.record(z.string(), z.unknown());
const validTokenLimit = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .optional()
  .catch(undefined);
const validFlag = z.boolean().optional().catch(undefined);
const modelSchema = z
  .object({
    id: z.string().optional().catch(undefined),
    name: z.string().optional().catch(undefined),
    model: z.string().optional().catch(undefined),
    displayName: z.string().optional().catch(undefined),
    display_name: z.string().optional().catch(undefined),
    inputTokenLimit: validTokenLimit,
    maxTokens: validTokenLimit,
    max_tokens: validTokenLimit,
    contextWindow: validTokenLimit,
    outputTokenLimit: validTokenLimit,
    maxOutputTokens: validTokenLimit,
    max_output_tokens: validTokenLimit,
    isInternal: validFlag,
    is_internal: validFlag,
    disabled: validFlag,
    supportsImages: validFlag,
    supports_images: validFlag,
    supportsThinking: validFlag,
    supports_thinking: validFlag,
    supportsAdaptiveThinking: validFlag,
    supports_adaptive_thinking: validFlag,
    supportsVideo: validFlag,
    supports_video: validFlag,
    supportsPdf: validFlag,
    supports_pdf: validFlag,
    supportedMimeTypes: unknownRecordSchema.optional().catch(undefined),
    supported_mime_types: unknownRecordSchema.optional().catch(undefined),
  })
  .passthrough();

function record(value: unknown): Record<string, unknown> {
  const parsed = unknownRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function flag(item: Record<string, unknown>, camel: string, snake: string): boolean | undefined {
  const value = item[camel] ?? item[snake];
  return typeof value === "boolean" ? value : undefined;
}

function positiveInteger(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
  );
}

const ROLE_FIELDS = {
  command: "commandModelIds",
  tab: "tabModelIds",
  image: "imageGenerationModelIds",
  search: "webSearchModelIds",
  transcription: "audioTranscriptionModelIds",
  commit: "commitMessageModelIds",
} as const;

function modelRoles(payload: Record<string, unknown>, id: string): string[] {
  const roles: string[] = [];
  for (const [role, field] of Object.entries(ROLE_FIELDS)) {
    const value = payload[field];
    if (Array.isArray(value) && value.includes(id)) roles.push(role);
  }
  const sorts = payload.agentModelSorts;
  if (
    Array.isArray(sorts) &&
    sorts.some((sort) => {
      const groups = record(sort).groups;
      return (
        Array.isArray(groups) &&
        groups.some((group) => {
          const ids = record(group).modelIds;
          return Array.isArray(ids) && ids.includes(id);
        })
      );
    })
  )
    roles.push("agent");
  if (payload.defaultAgentModelId === id && !roles.includes("agent")) roles.push("agent");
  return roles;
}

/** Native protobuf maps and legacy array payloads are both accepted; no guessed limits. */
export function normalizeCodeAssistDiscovery(data: unknown): CodeAssistDiscoveredModel[] {
  const payload = record(data);
  const models = payload.models;
  const entries: Array<[string, unknown]> = Array.isArray(models)
    ? models.map((value) => {
        const item = record(value);
        const id = [item.id, item.name, item.model].find((v) => typeof v === "string") ?? "";
        return [String(id), value];
      })
    : Object.entries(record(models));
  const result: CodeAssistDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const [rawId, value] of entries) {
    const id = rawId.trim();
    if (!id || id.length > 256 || seen.has(id) || /[\u0000-\u001f\u007f]/.test(id)) continue;
    const parsed = modelSchema.safeParse(value);
    if (!parsed.success) continue;
    const item = parsed.data;
    const name =
      [item.displayName, item.display_name, item.name].find(
        (v) => typeof v === "string" && v.length > 0
      ) ?? id;
    const model: CodeAssistDiscoveredModel = { id, name: String(name) };
    const input = positiveInteger(
      item.inputTokenLimit,
      item.maxTokens,
      item.max_tokens,
      item.contextWindow
    );
    const output = positiveInteger(
      item.outputTokenLimit,
      item.maxOutputTokens,
      item.max_output_tokens
    );
    if (input !== undefined) model.inputTokenLimit = input;
    if (output !== undefined) model.outputTokenLimit = output;
    for (const [camel, snake] of Object.entries({
      isInternal: "is_internal",
      disabled: "disabled",
      supportsImages: "supports_images",
      supportsThinking: "supports_thinking",
      supportsAdaptiveThinking: "supports_adaptive_thinking",
      supportsVideo: "supports_video",
      supportsPdf: "supports_pdf",
    })) {
      const value = flag(item, camel, snake);
      if (value !== undefined) Object.assign(model, { [camel]: value });
    }
    const mime = record(item.supportedMimeTypes ?? item.supported_mime_types);
    const mimeEntries = Object.entries(mime).filter(
      ([name, enabled]) =>
        name.length <= 128 &&
        /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(name) &&
        typeof enabled === "boolean"
    );
    if (mimeEntries.length > 0)
      model.supportedMimeTypes = Object.fromEntries(mimeEntries.slice(0, 128));
    const roles = modelRoles(payload, id);
    if (roles.length > 0) model.discoveryRoles = roles;
    result.push(model);
    seen.add(id);
  }
  return result;
}

/** Distinguish a signed empty catalog from an unavailable/malformed response. */
export function normalizeCodeAssistCatalogReply(data: unknown): CodeAssistDiscoveredModel[] | null {
  const models = record(data).models;
  if (!Array.isArray(models) && (!models || typeof models !== "object")) return null;
  const normalized = normalizeCodeAssistDiscovery(data);
  const count = Array.isArray(models) ? models.length : Object.keys(models).length;
  return count > 0 && normalized.length === 0 ? null : normalized;
}
