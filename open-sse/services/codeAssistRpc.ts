/** Versioned CCPA request compiler. It performs no networking or caller tools.
 * Consumer/business AI Code and public Gemini Live are distinct protocols.
 */
import { z } from "zod";
import { ANTIGRAVITY_RUNTIME_BASE_URLS } from "../config/antigravityUpstream.ts";

export type CodeAssistSurface =
  "cloud-code" | "consumer-ai-code" | "business-ai-code" | "gemini-api" | "antigravity-local-sdk";

export const CODE_ASSIST_SURFACES = Object.freeze({
  "cloud-code": {
    generation: "existing-validated",
    countTokens: "schema-verified",
    explicitCacheReference: "schema-verified-not-entitlement",
    cacheManagement: "not-exposed",
    callerTools: "caller-owned",
  },
  "consumer-ai-code": {
    generation: "wire-auth-unverified",
    countTokens: "not-in-prediction-service",
    explicitCacheReference: "not-in-request",
    cacheManagement: "not-exposed",
    callerTools: "function-response-schema",
  },
  "business-ai-code": {
    generation: "wire-auth-unverified",
    countTokens: "not-in-prediction-service",
    explicitCacheReference: "not-in-request",
    cacheManagement: "not-exposed",
    callerTools: "function-response-schema",
  },
  "gemini-api": {
    generation: "separate-public-api",
    countTokens: "public-api",
    explicitCacheReference: "public-api",
    cacheManagement: "separate-public-api",
    callerTools: "caller-owned-with-afc-disabled",
  },
  "antigravity-local-sdk": {
    generation: "agent-runtime-not-proxy-transport",
    countTokens: "runtime-owned",
    explicitCacheReference: "not-in-local-proto",
    cacheManagement: "not-exposed",
    callerTools: "runtime-tool-runner",
  },
} as const);

const modelSchema = z.string().regex(/^[a-zA-Z0-9._/-]{1,256}$/);
const contentSchema = z
  .object({
    role: z.string().max(32).optional(),
    parts: z.array(z.record(z.string(), z.unknown())).min(1),
  })
  .strict();
const countInputSchema = z
  .object({
    contents: z.array(contentSchema).min(1),
    systemInstruction: contentSchema.optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    generationConfig: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Exact native CountTokens envelope: it has request only, no project/model root. */
export function buildCodeAssistCountTokensRequest(
  model: unknown,
  input: unknown
): {
  request: z.infer<typeof countInputSchema> & { model: string };
} {
  return { request: { ...countInputSchema.parse(input), model: modelSchema.parse(model) } };
}

/** Fixed signed-discovery endpoint; no caller endpoint substitution or credential URL. */
export function buildCodeAssistReadOnlyRpcPlan(
  surface: CodeAssistSurface,
  method: "countTokens" | "fetchAvailableModels",
  body: unknown,
  origin: string = ANTIGRAVITY_RUNTIME_BASE_URLS[0]
): { url: string; method: "POST"; body: Record<string, unknown> } {
  if (surface !== "cloud-code")
    throw new Error("Code Assist surface requires verified account wire/auth eligibility");
  if (!(ANTIGRAVITY_RUNTIME_BASE_URLS as readonly string[]).includes(origin))
    throw new Error("Unapproved Code Assist origin");
  if (method === "countTokens") {
    const parsed = z
      .object({ request: countInputSchema.extend({ model: modelSchema }) })
      .strict()
      .parse(body);
    return { url: `${origin}/v1internal:countTokens`, method: "POST", body: parsed };
  }
  const parsed = z
    .object({
      project: z.string().min(1).max(256).optional(),
      requestId: z.string().max(256).optional(),
    })
    .strict()
    .parse(body);
  return { url: `${origin}/v1internal:fetchAvailableModels`, method: "POST", body: parsed };
}

export function parseCodeAssistCountTokensResponse(body: unknown): number {
  return z.object({ totalTokens: z.number().int().nonnegative().max(2147483647) }).parse(body)
    .totalTokens;
}
