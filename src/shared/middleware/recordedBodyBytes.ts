/** Trusted ingress body-byte stamp; measured counts live only in this WeakMap, never headers. */
export const RECORDED_BODY_BYTES_HEADER = "x-omniroute-recorded-body-bytes";

const recordedBodyBytesMap = new WeakMap<Request, number>();

export function recordBodyBytes(request: Request, bytes: number): void {
  recordedBodyBytesMap.set(request, bytes);
}

export function readRecordedBodyBytes(request: Request): number | null {
  const measured = recordedBodyBytesMap.get(request);
  return typeof measured === "number" && Number.isSafeInteger(measured) && measured >= 0
    ? measured
    : null;
}

export function transferRecordedBodyBytes(source: Request, destination: Request): Request {
  const measured = recordedBodyBytesMap.get(source);
  if (typeof measured === "number" && Number.isSafeInteger(measured) && measured >= 0) {
    recordedBodyBytesMap.set(destination, measured);
  }
  return destination;
}

export function getSanitizedRequestHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  // The inbound value may be absent or dishonest. Let the runtime derive the correct value.
  headers.delete("content-length");
  headers.delete(RECORDED_BODY_BYTES_HEADER);
  return headers;
}

export function stampRecordedBodyBytes(request: Request, bytes: number): Request {
  recordBodyBytes(request, bytes);
  return request;
}

export function rebuildRequest(request: Request, body: Uint8Array): Request {
  const headers = getSanitizedRequestHeaders(request);
  const rebuilt = new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return transferRecordedBodyBytes(request, rebuilt);
}
