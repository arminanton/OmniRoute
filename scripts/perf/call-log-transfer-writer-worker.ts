import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";

// Match the production artifact worker's module footprint. The benchmark path
// writes already serialized bytes; importing the module also anchors the
// serializer-byte comparison to the same production package graph.
import { CALL_LOGS_DIR } from "../../src/lib/usage/callLogArtifacts.ts";

void CALL_LOGS_DIR;
parentPort?.on(
  "message",
  (request: { directory: string; relativePath: string; bytes: Uint8Array }) => {
    const target = path.join(request.directory, request.relativePath);
    const bytes = Buffer.from(
      request.bytes.buffer,
      request.bytes.byteOffset,
      request.bytes.byteLength
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(target, bytes);
    parentPort?.postMessage({ bytesWritten: bytes.byteLength, sha256 });
  }
);
parentPort?.postMessage({ ready: true });
