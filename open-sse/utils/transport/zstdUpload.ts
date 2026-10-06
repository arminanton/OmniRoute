import * as zlib from "node:zlib";
import { BoundedAdmission } from "./boundedAdmission.ts";

export interface ZstdUploadPolicy {
  /** Exact endpoint URLs verified by the operator; no provider-wide assumption. */
  verifiedEndpoints: readonly string[];
  thresholdBytes?: number;
  maxInputBytes?: number;
  minimumSavingsRatio?: number;
  /** Default matches documented OpenAI Responses decompression safety limit. */
  maxExpansionRatio?: number;
}
const compressionAdmission = new BoundedAdmission(4, 128, 30000);
const native = zlib as unknown as {
  zstdCompress?: (body: Buffer, callback: (error: Error | null, result: Buffer) => void) => void;
};

export async function prepareZstdUpload(url: string, init: RequestInit, policy: ZstdUploadPolicy) {
  const unchanged = { init, compressed: false, originalBytes: 0, uploadBytes: 0 };
  if (
    typeof init.body !== "string" ||
    !policy.verifiedEndpoints.includes(url) ||
    !native.zstdCompress
  )
    return unchanged;
  const headers = new Headers(init.headers);
  if (headers.has("content-encoding")) return unchanged;
  const originalBytes = Buffer.byteLength(init.body, "utf8");
  if (
    originalBytes < (policy.thresholdBytes ?? 32768) ||
    originalBytes > Math.min(policy.maxInputBytes ?? 16 * 1024 * 1024, 128 * 1024 * 1024)
  )
    return { ...unchanged, originalBytes, uploadBytes: originalBytes };
  const release = await compressionAdmission.acquire(init.signal);
  try {
    init.signal?.throwIfAborted();
    const compressed = await new Promise<Buffer>((resolve, reject) =>
      native.zstdCompress!(Buffer.from(init.body as string, "utf8"), (error, result) =>
        error ? reject(error) : resolve(result)
      )
    );
    init.signal?.throwIfAborted();
    if (compressed.length >= originalBytes * (1 - (policy.minimumSavingsRatio ?? 0.1)))
      return { ...unchanged, originalBytes, uploadBytes: originalBytes };
    // A tiny compressed body can violate an upstream decompression/bomb guard.
    // Keep the original wire representation rather than inventing padding frames.
    if (originalBytes > compressed.byteLength * Math.min(policy.maxExpansionRatio ?? 100, 100))
      return { ...unchanged, originalBytes, uploadBytes: originalBytes };
    headers.set("Content-Encoding", "zstd");
    headers.set("Content-Length", String(compressed.byteLength));
    return {
      init: { ...init, body: new Uint8Array(compressed), headers },
      compressed: true,
      originalBytes,
      uploadBytes: compressed.byteLength,
    };
  } finally {
    release();
  }
}

/** Only an explicit encoding rejection can authorize an uncompressed attempt. */
export async function fetchWithVerifiedZstd(
  url: string,
  init: RequestInit,
  policy: ZstdUploadPolicy,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  /** Shared logical retry/deadline owner must explicitly approve; default is no retry. */
  approveEncodingRetry?: () => boolean | Promise<boolean>
) {
  const upload = await prepareZstdUpload(url, init, policy);
  const response = await fetcher(url, upload.init);
  const accepted = response.headers.get("Accept-Encoding");
  const rejectsZstd =
    accepted !== null &&
    !accepted.split(",").some((value) => value.trim().split(";")[0].toLowerCase() === "zstd");
  if (
    !upload.compressed ||
    response.status !== 415 ||
    !rejectsZstd ||
    !approveEncodingRetry ||
    init.signal?.aborted
  )
    return response;
  if (!(await approveEncodingRetry())) return response;
  await response.body?.cancel();
  init.signal?.throwIfAborted();
  // Original serialization, headers and byte representation are preserved exactly.
  return fetcher(url, init);
}
