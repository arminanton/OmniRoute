/** Keep dependency-internal H2 retries from silently replaying a generation POST. */
export function nonReplayableUpload(init: RequestInit): RequestInit {
  let bytes: Uint8Array;
  if (typeof init.body === "string") bytes = Buffer.from(init.body, "utf8");
  else if (init.body instanceof Uint8Array) bytes = init.body;
  else if (init.body instanceof ArrayBuffer) bytes = new Uint8Array(init.body);
  else return init;
  const headers = new Headers(init.headers);
  headers.set("Content-Length", String(bytes.byteLength));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { ...init, headers, body, duplex: "half" } as RequestInit;
}
