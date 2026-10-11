import fs from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { DiagnosticOverflowCoordinator } from "./diagnosticOverflowCoordinator";
import {
  fileName,
  privateDirectory,
  syncDirectory,
  safeReason,
} from "./diagnosticOverflowFilesystem";
import type { DiagnosticOverflowFile, DiagnosticOverflowKind } from "./diagnosticOverflowTypes";
const sync = (fd: number) =>
  new Promise<void>((resolve, reject) =>
    fs.fsync(fd, (error) => (error ? reject(error) : resolve()))
  );
export class DiagnosticOverflowWriter {
  private gzip = createGzip({ level: 1, chunkSize: 64 * 1024 });
  private output: fs.WriteStream | undefined;
  private fd: number | undefined;
  private rawHash = createHash("sha256");
  private gzipHash = createHash("sha256");
  private rawBytes = 0;
  private compressedBytes = 0;
  private credit = 0;
  private stopped = false;
  private sealed = false;
  private reason: string | undefined;
  private queuedBytes = 0;
  private chain: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private sealPromise: Promise<void> | undefined;
  accepting(): boolean {
    return !this.stopped && !this.sealed;
  }
  constructor(
    private coordinator: DiagnosticOverflowCoordinator,
    private traceId: string,
    private owner: string,
    private attemptId: string,
    private kind: DiagnosticOverflowKind,
    private incomplete: (reason: string) => void
  ) {
    try {
      if (!coordinator.createFile(traceId, owner, attemptId, kind)) {
        this.stop("aggregate_budget");
        return;
      }
      const directory = path.join(coordinator.root, traceId);
      privateDirectory(directory);
      this.fd = fs.openSync(
        path.join(directory, fileName(attemptId, kind)),
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_WRONLY,
        0o600
      );
      syncDirectory(directory);
      this.output = fs.createWriteStream("", {
        fd: this.fd,
        autoClose: false,
        highWaterMark: 64 * 1024,
      });
      this.gzip.on("data", (chunk: Buffer) => {
        this.compressedBytes += chunk.byteLength;
        this.gzipHash.update(chunk);
      });
      const failed = (error: Error) => {
        this.failure = error;
        this.stop("write_error");
        this.gzip.destroy(error);
      };
      this.output.on("error", failed);
      this.gzip.on("error", failed);
      this.gzip.pipe(this.output);
    } catch {
      this.stop("write_error");
    }
  }
  private stop(reason: string): void {
    this.stopped = true;
    this.reason ??= safeReason(reason);
    this.incomplete(this.reason);
  }
  write(chunk: Uint8Array): Promise<void> {
    if (this.stopped || this.sealed) return Promise.resolve();
    if (this.queuedBytes > 0 && this.queuedBytes + chunk.byteLength > 256 * 1024) {
      this.stop("backpressure_overflow");
      return Promise.resolve();
    }
    this.queuedBytes += chunk.byteLength;
    this.chain = this.chain
      .then(async () => {
        if (this.stopped) return;
        try {
          this.coordinator.assertOwner(this.traceId, this.owner);
          for (let offset = 0; offset < chunk.byteLength && !this.stopped; offset += 64 * 1024) {
            let part = chunk.subarray(offset, Math.min(chunk.byteLength, offset + 64 * 1024));
            const room = this.coordinator.maxFileBytes - this.rawBytes;
            if (room <= 0) {
              this.stop("size_limit");
              break;
            }
            if (part.byteLength > room) part = part.subarray(0, room);
            if (this.credit < part.byteLength)
              this.credit += this.coordinator.reserve(
                this.traceId,
                this.owner,
                this.attemptId,
                this.kind,
                Math.min(1024 * 1024, this.coordinator.maxFileBytes - this.rawBytes - this.credit)
              );
            if (this.credit < part.byteLength) part = part.subarray(0, this.credit);
            if (!part.byteLength) {
              this.stop("aggregate_budget");
              break;
            }
            await new Promise<void>((resolve, reject) =>
              this.gzip.write(part, (error) => (error ? reject(error) : resolve()))
            );
            this.rawHash.update(part);
            this.rawBytes += part.byteLength;
            this.credit -= part.byteLength;
            if (part.byteLength < Math.min(chunk.byteLength - offset, 64 * 1024))
              this.stop(
                this.rawBytes >= this.coordinator.maxFileBytes ? "size_limit" : "aggregate_budget"
              );
          }
        } catch (error) {
          this.stop(
            error instanceof Error && error.message === "lease_lost" ? "lease_lost" : "write_error"
          );
        }
      })
      .finally(() => {
        this.queuedBytes -= chunk.byteLength;
      });
    return this.chain;
  }
  async writeBody(body: string | Uint8Array): Promise<void> {
    if (typeof body !== "string") {
      for (let offset = 0; offset < body.byteLength && !this.stopped; offset += 64 * 1024)
        await this.write(body.subarray(offset, offset + 64 * 1024));
      return;
    }
    // Preserve UTF-8 across JavaScript surrogate boundaries without duplicating the whole body.
    for (let offset = 0; offset < body.length && !this.stopped;) {
      let end = Math.min(body.length, offset + 16 * 1024);
      if (
        end < body.length &&
        body.charCodeAt(end - 1) >= 0xd800 &&
        body.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      await this.write(Buffer.from(body.slice(offset, end), "utf8"));
      offset = end;
    }
  }
  seal(complete: boolean, reason = "missing_eof"): Promise<void> {
    this.sealPromise ??= this.sealInternal(complete, reason);
    return this.sealPromise;
  }
  private async sealInternal(complete: boolean, reason: string): Promise<void> {
    if (this.sealed) return;
    this.sealed = true;
    await this.chain;
    if (!complete) this.stop(reason);
    try {
      if (!this.output || this.fd === undefined || this.failure) throw new Error("write_error");
      const finished = once(this.output, "finish");
      this.gzip.end();
      await finished;
      await sync(this.fd);
      fs.closeSync(this.fd);
      this.fd = undefined;
      syncDirectory(path.join(this.coordinator.root, this.traceId));
      const metadata: DiagnosticOverflowFile = {
        representation:
          this.kind === "client_request"
            ? "parsed_json_reserialized_utf8"
            : this.kind === "provider_request"
              ? "serialized_provider_request_utf8"
              : "decoded_upstream_bytes",
        state: this.reason ? "incomplete" : "complete",
        complete: !this.reason && complete,
        reason: this.reason,
        rawBytes: this.rawBytes,
        compressedBytes: this.compressedBytes,
        sha256: this.rawHash.digest("hex"),
        gzipSha256: this.gzipHash.digest("hex"),
      };
      this.coordinator.sealFile(this.traceId, this.owner, this.attemptId, this.kind, metadata);
    } catch {
      this.stop("write_error");
      this.gzip.destroy();
      this.output?.destroy();
      if (this.fd !== undefined) {
        try {
          fs.closeSync(this.fd);
        } catch {}
        this.fd = undefined;
      }
      try {
        this.coordinator.sealFile(this.traceId, this.owner, this.attemptId, this.kind, {
          state: "incomplete",
          complete: false,
          reason: this.reason,
          rawBytes: this.rawBytes,
          compressedBytes: this.compressedBytes,
        });
      } catch {}
    }
  }
}
