/** Explicit CCPA cache references require server-owned scope evidence.
 * Schema support is not cache entitlement. This module creates/deletes no caches.
 */
import { z } from "zod";

const referenceSchema = z
  .string()
  .max(1024)
  .regex(
    /^(?:projects\/[a-zA-Z0-9_.-]+\/locations\/[a-zA-Z0-9_.-]+\/)?cachedContents\/[a-zA-Z0-9_.-]+$/
  );
const receiptSchema = z
  .object({
    issuer: z.literal("omni-code-assist-cache-ownership/v1"),
    surface: z.literal("cloud-code"),
    serviceCapabilityVerified: z.literal(true),
    reference: referenceSchema,
    connectionId: z.string().min(1).max(256),
    projectId: z.string().min(1).max(256),
    namespace: z.string().regex(/^ag:[a-f0-9]{64}$/),
    model: z.string().min(1).max(256),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type CodeAssistCacheOwnershipReceipt = z.infer<typeof receiptSchema>;
export type CodeAssistCacheCredentials = {
  connectionId?: string | null;
  projectId?: string | null;
  _signatureNamespace?: string | null;
  /** Private ephemeral credentials state, never accepted from a request body. */
  _codeAssistCacheOwnershipReceipt?: unknown;
};

export class CodeAssistCacheReferenceError extends Error {
  readonly status = 400;
  readonly code = "unverified_code_assist_cache_reference";
  constructor() {
    super(
      "Explicit Code Assist cache reference requires verified caller, account, conversation and model ownership."
    );
    this.name = "CodeAssistCacheReferenceError";
  }
}

export function guardCodeAssistCacheReference(
  request: Record<string, unknown>,
  credentials: CodeAssistCacheCredentials,
  model: string,
  now = Date.now()
): Record<string, unknown> {
  const hasCamel = request.cachedContent !== undefined;
  const hasSnake = request.cached_content !== undefined;
  if (!hasCamel && !hasSnake) return request;
  if (hasCamel && hasSnake && request.cachedContent !== request.cached_content)
    throw new CodeAssistCacheReferenceError();
  const reference = referenceSchema.safeParse(request.cachedContent ?? request.cached_content);
  const ownership = receiptSchema.safeParse(credentials._codeAssistCacheOwnershipReceipt);
  if (!reference.success || !ownership.success) throw new CodeAssistCacheReferenceError();
  const receipt = ownership.data;
  if (
    receipt.reference !== reference.data ||
    receipt.connectionId !== credentials.connectionId ||
    receipt.projectId !== credentials.projectId ||
    receipt.namespace !== credentials._signatureNamespace ||
    receipt.model !== model ||
    receipt.expiresAt <= now
  ) {
    throw new CodeAssistCacheReferenceError();
  }
  // Do not discard an unverified cache and then generate from an incomplete prompt.
  const result: Record<string, unknown> = { ...request, cachedContent: reference.data };
  delete result.cached_content;
  return result;
}
