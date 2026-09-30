/**
 * MaxAI doc-RAG — inline document parts → /app/upload_document → doc_list.
 *
 * OmniRoute delivers attached documents INLINE in the chat request as base64
 * `file_data` content parts (OpenAI `{type:"file",file:{filename,file_data}}` /
 * Responses `{type:"input_file",file_data}` / Claude `{type:"document",source}`).
 * MaxAI's `/gpt/cwc/chat` cannot take binary docs inline; instead it references
 * uploaded documents by a content-addressed `doc_id`. This module bridges the
 * two: it detects inline base64 doc parts on the current turn, uploads each via
 * the multipart `/app/upload_document` endpoint (signed like every MaxAI call),
 * and returns the `doc_list` entries to attach to the chat body.
 *
 * doc_id is NOT random — MaxAI requires `doc_id = HMAC-SHA1(file_bytes, IT)` hex
 * (createDocId/qM in the extension). A random id is rejected with a 400
 * "Inconsistency between server doc_id and request doc_id". The IT key is a
 * public web-app constant (ships in the bundle), same class as the signing
 * constants; kept here as a named constant (not a secret).
 *
 * The doc_list item shape is exactly what the live web app sends
 * (site chunk 41068): `{ doc_id, doc_type, file_name }`.
 */
import { isRuntimePolicyError } from "@/shared/runtimePolicy";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { maxaiFetch } from "../../services/maxaiTransport.ts";
import { buildMaxaiSignedHeaders } from "./signing.ts";
import { ensureMaxaiConstants } from "./constantsStore.ts";
import { maxaiStaticHeaders, MAXAI_BASE_URL } from "./protocol.ts";

export const MAXAI_UPLOAD_PATH = "/app/upload_document";

export interface MaxaiDocListEntry {
  doc_id: string;
  doc_type: string;
  file_name: string;
}

/** An inline document extracted from an OpenAI/Responses/Claude content part. */
export interface InlineDoc {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

/** doc_id = HMAC-SHA1(file_bytes, docIdKey) hex. Content-addressed; MaxAI verifies it. */
export function computeMaxaiDocId(bytes: Buffer, key: string): string {
  if (!key) throw new Error("computeMaxaiDocId: missing docIdKey");
  return createHmac("sha1", key).update(bytes).digest("hex");
}

const TEXTUAL_EXT = /\.(txt|md|markdown|csv|json|log|xml|yaml|yml|tsv)$/i;
const CODE_EXT =
  /\.(py|ipynb|js|jsx|ts|tsx|html?|css|java|cs|php|c|cpp|cxx|h|hpp|go|rs|rb|swift|kt|sh|sql)$/i;

/** Classify the MaxAI doc_type from the filename/mime (extension taxonomy). */
export function maxaiDocType(filename: string, mimeType: string): string {
  const f = filename.toLowerCase();
  if (/\.pdf$/i.test(f) || mimeType === "application/pdf") return "page_content__pdf";
  if (CODE_EXT.test(f)) return "chat_file_code";
  return "chat_file"; // text / generic
}

/** Whether a doc_type requires the pure_text field (text-extractable docs). */
function requiresPureText(docType: string): boolean {
  return docType === "chat_file" || docType === "chat_file_code";
}

/** Request-wide bound on decoded document bytes, not encoded characters. */
export const MAXAI_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_FILENAME_BYTES = 255;
const DEFAULT_MIME_TYPE = "application/octet-stream";
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Fixed messages only: never attach document contents, URLs or upstream bodies. */
export class MaxaiDocumentError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "MaxaiDocumentError";
  }
}

const filenameSchema = z
  .string()
  .min(1)
  .max(MAX_FILENAME_BYTES)
  .refine(
    (name) =>
      Buffer.byteLength(name, "utf8") <= MAX_FILENAME_BYTES &&
      !Array.from(name).some((char) => {
        const code = char.codePointAt(0)!;
        return code < 32 || code === 127 || char === '"' || char === "\\";
      })
  );
const mimeTypeSchema = z
  .string()
  .max(127)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/);
const documentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("file"),
    file: z.object({
      filename: filenameSchema.optional(),
      file_data: z.string().optional(),
      data: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("input_file"),
    filename: filenameSchema.optional(),
    file_data: z.string(),
  }),
  z.object({
    type: z.literal("document"),
    title: filenameSchema.optional(),
    source: z.object({
      type: z.literal("base64"),
      media_type: mimeTypeSchema.optional(),
      data: z.string(),
    }),
  }),
]);
const inlineDocSchema = z.object({
  filename: filenameSchema,
  mimeType: mimeTypeSchema,
  bytes: z.custom<Buffer>((value) => Buffer.isBuffer(value) && value.length > 0),
});

interface DocumentPayload {
  mimeType: string;
  data: string;
  encoding: "base64" | "utf8";
  size: number;
}

function checkDocumentSize(size: number, limit: number): void {
  if (size > limit) {
    throw new MaxaiDocumentError("MaxAI documents exceed the 64 MiB decoded limit", 413);
  }
}

function validateInlineDoc(doc: InlineDoc): void {
  if (!inlineDocSchema.safeParse(doc).success) {
    throw new MaxaiDocumentError("MaxAI document has invalid data, filename or MIME type");
  }
  checkDocumentSize(doc.bytes.length, MAXAI_MAX_DOCUMENT_BYTES);
}

/** Validate canonical RFC 4648 base64 before Buffer.from's permissive decoder. */
function prepareBase64(data: string, mimeType: string, limit: number): DocumentPayload {
  if (!data.length || data.length % 4 !== 0) {
    throw new MaxaiDocumentError("MaxAI document contains malformed base64 data");
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const size = (data.length / 4) * 3 - padding;
  checkDocumentSize(size, limit);
  const alphabet = data.slice(0, data.length - padding);
  const last = BASE64_ALPHABET.indexOf(alphabet.at(-1)!);
  if (
    /[^A-Za-z0-9+/]/.test(alphabet) ||
    (padding === 2 && (last & 15) !== 0) ||
    (padding === 1 && (last & 3) !== 0)
  ) {
    throw new MaxaiDocumentError("MaxAI document contains malformed base64 data");
  }
  return { mimeType, data, encoding: "base64", size };
}

function prepareDataUrl(raw: unknown, limit: number): DocumentPayload {
  if (typeof raw !== "string") {
    throw new MaxaiDocumentError(
      "MaxAI documents require inline data; URLs and file IDs are unsupported"
    );
  }
  const comma = raw.indexOf(",");
  // Bound the header match separately; never accept MIME parameters that the
  // current inline-document contract lacks or fetch an arbitrary document URL.
  const header =
    comma > 0 && comma <= 150 ? /^data:([^;,]*)(;base64)?$/.exec(raw.slice(0, comma)) : null;
  if (!header) {
    throw new MaxaiDocumentError(
      "MaxAI documents require inline data; URLs and file IDs are unsupported"
    );
  }
  const mimeType = header[1] || DEFAULT_MIME_TYPE;
  if (!mimeTypeSchema.safeParse(mimeType).success) {
    throw new MaxaiDocumentError("MaxAI document has an invalid MIME type");
  }
  const data = raw.slice(comma + 1);
  if (header[2]) return prepareBase64(data, mimeType, limit);

  // Keep the existing percent-encoded data-URL contract. A decoded byte uses
  // at most three encoded characters. Check before allocating the UTF-8 Buffer.
  checkDocumentSize(Math.ceil(data.length / 3), limit);
  let text: string;
  try {
    text = decodeURIComponent(data);
  } catch {
    throw new MaxaiDocumentError("MaxAI document contains malformed data-URL text");
  }
  if (!text.length) throw new MaxaiDocumentError("MaxAI document data is empty");
  const size = Buffer.byteLength(text, "utf8");
  checkDocumentSize(size, limit);
  return { mimeType, data: text, encoding: "utf8", size };
}

/** Strict inline parser. Invalid/unsupported inputs return null; no URL fetch. */
export function parseInlineDataUrl(dataUrl: unknown): { mimeType: string; bytes: Buffer } | null {
  try {
    const payload = prepareDataUrl(dataUrl, MAXAI_MAX_DOCUMENT_BYTES);
    return { mimeType: payload.mimeType, bytes: Buffer.from(payload.data, payload.encoding) };
  } catch (error) {
    if (error instanceof MaxaiDocumentError) return null;
    throw error;
  }
}

/**
 * Extract documents from the last user turn. Validate the entire turn and its
 * total decoded size before allocating document buffers or starting uploads.
 * Other media belongs to its own path; recognized document parts cannot be skipped.
 */
export function extractCurrentTurnDocs(
  messages: Array<{ role?: string; content?: unknown }>
): InlineDoc[] {
  let content: unknown;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      content = messages[i]?.content;
      break;
    }
  }
  if (!Array.isArray(content)) return [];
  const prepared: Array<DocumentPayload & { filename: string }> = [];
  let remaining = MAXAI_MAX_DOCUMENT_BYTES;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const type = (part as Record<string, unknown>).type;
    if (type !== "file" && type !== "input_file" && type !== "document") continue;
    const parsed = documentPartSchema.safeParse(part);
    if (!parsed.success) {
      throw new MaxaiDocumentError(
        "MaxAI document has missing or invalid inline data, filename or MIME type"
      );
    }
    const p = parsed.data;
    let filename: string;
    let payload: DocumentPayload;
    if (p.type === "document") {
      const mimeType = p.source.media_type ?? DEFAULT_MIME_TYPE;
      payload = prepareBase64(p.source.data, mimeType, remaining);
      filename = p.title ?? `document.${mimeExt(mimeType)}`;
    } else {
      const file = p.type === "file" ? p.file : p;
      const raw = p.type === "file" ? (p.file.file_data ?? p.file.data) : p.file_data;
      payload = prepareDataUrl(raw, remaining);
      filename = file.filename ?? "upload.bin";
    }
    remaining -= payload.size;
    prepared.push({ ...payload, filename });
  }
  return prepared.map(({ filename, mimeType, data, encoding }) => ({
    filename,
    mimeType,
    bytes: Buffer.from(data, encoding),
  }));
}

function mimeExt(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "txt";
  return "bin";
}

/** Rough ~4-chars/token estimate; ceil, never 0 for non-empty text. */
function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

/** Build the multipart/form-data body for /app/upload_document (fixed boundary). */
export function buildUploadMultipart(
  doc: InlineDoc,
  docId: string,
  docType: string,
  boundary: string
): Buffer {
  validateInlineDoc(doc);
  const isTextual =
    requiresPureText(docType) &&
    (TEXTUAL_EXT.test(doc.filename) ||
      CODE_EXT.test(doc.filename) ||
      doc.mimeType.startsWith("text/"));
  const pureText = isTextual ? doc.bytes.toString("utf8") : "";
  const tokens = String(estimateTokens(pureText));

  const parts: Buffer[] = [];
  const dash = `--${boundary}\r\n`;
  const field = (name: string, value: string): void => {
    parts.push(
      Buffer.from(`${dash}Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    );
  };
  field("doc_id", docId);
  field("doc_type", docType);
  field("pure_text", pureText);
  field("tokens", tokens);
  field("doc_type_dependent_data", "{}");
  // The file part carries the raw bytes with a content-type.
  parts.push(
    Buffer.from(
      `${dash}Content-Disposition: form-data; name="file"; filename="${doc.filename.replace(/"/g, "")}"\r\n` +
        `Content-Type: ${doc.mimeType}\r\n\r\n`
    )
  );
  parts.push(doc.bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

/** True only for a parsed terminal upload event, never a substring in an error. */
export function sawUploadDone(text: string): boolean {
  const isDone = (data: string): boolean => {
    try {
      const event: unknown = JSON.parse(data);
      return (
        !!event &&
        typeof event === "object" &&
        (event as Record<string, unknown>).event === "upload_done"
      );
    } catch {
      return false;
    }
  };
  if (isDone(text)) return true;
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n\n")
    .some((frame) => {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      return isDone(data);
    });
}

function cancelResponse(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** Do not rely on a fetch/stream implementation to observe the caller signal. */
function withAbort<T>(
  work: Promise<T>,
  signal?: AbortSignal,
  discard?: (value: T) => void
): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          discard?.(value);
          reject(signal.reason);
        } else {
          resolve(value);
        }
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? signal.reason : error);
      }
    );
    if (signal.aborted) onAbort();
  });
}

async function readUploadResponse(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) return withAbort(response.text(), signal);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let complete = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) {
        complete = true;
        chunks.push(decoder.decode());
        return chunks.join("");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Upload one document. A failed upload must never silently drop an attachment. */
export async function uploadMaxaiDocument(
  doc: InlineDoc,
  auth: { accessToken: string; userId: string; deviceId: string },
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<MaxaiDocListEntry> {
  const signal = opts?.signal;
  signal?.throwIfAborted();
  validateInlineDoc(doc);
  const fetchImpl = opts?.fetchImpl ?? maxaiFetch;
  try {
    const constants = await withAbort(ensureMaxaiConstants({ fetchImpl, signal }), signal);
    signal?.throwIfAborted();
    if (!constants) throw new MaxaiDocumentError("MaxAI signing constants unavailable", 503);
    const docId = computeMaxaiDocId(doc.bytes, constants.docIdKey);
    const docType = maxaiDocType(doc.filename, doc.mimeType);
    const boundary = `----maxai${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const bodyBuf = buildUploadMultipart(doc, docId, docType, boundary);

    // Keep the signer unchanged. Only the JSON content-type is replaced with
    // the multipart content-type, as required by /app/upload_document.
    const { "Content-Type": _drop, ...staticHeaders } = maxaiStaticHeaders();
    const headers: Record<string, string> = {
      ...staticHeaders,
      ...buildMaxaiSignedHeaders(
        { path: MAXAI_UPLOAD_PATH, userId: auth.userId, deviceId: auth.deviceId },
        constants
      ),
      Authorization: `Bearer ${auth.accessToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    // A plain ArrayBuffer-backed Uint8Array is accepted by fetch BodyInit.
    const bodyBytes = new Uint8Array(bodyBuf.byteLength);
    bodyBytes.set(bodyBuf);
    signal?.throwIfAborted();
    const response = await withAbort(
      fetchImpl(MAXAI_BASE_URL + MAXAI_UPLOAD_PATH, {
        method: "POST",
        headers,
        body: bodyBytes,
        signal,
        redirect: "error",
      }),
      signal,
      cancelResponse
    );
    if (signal?.aborted) {
      cancelResponse(response);
      signal.throwIfAborted();
    }
    if (!response.ok) {
      cancelResponse(response);
      throw new MaxaiDocumentError("MaxAI document upload failed", response.status);
    }
    const text = await readUploadResponse(response, signal);
    signal?.throwIfAborted();
    if (!sawUploadDone(text)) {
      throw new MaxaiDocumentError("MaxAI document upload did not complete", 502);
    }
    return { doc_id: docId, doc_type: docType, file_name: doc.filename };
  } catch (error) {
    if (isRuntimePolicyError(error)) throw error;
    signal?.throwIfAborted();
    if (
      error instanceof MaxaiDocumentError ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw error;
    }
    throw new MaxaiDocumentError("MaxAI document upload failed", 502);
  }
}

/** Validate the whole turn first, then upload serially and stop on any failure. */
export async function resolveMaxaiDocList(
  messages: Array<{ role?: string; content?: unknown }>,
  auth: { accessToken: string; userId: string; deviceId: string },
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal }
): Promise<MaxaiDocListEntry[]> {
  opts?.signal?.throwIfAborted();
  const docs = extractCurrentTurnDocs(messages);
  const results: MaxaiDocListEntry[] = [];
  for (const doc of docs) {
    opts?.signal?.throwIfAborted();
    results.push(await uploadMaxaiDocument(doc, auth, opts));
  }
  return results;
}
