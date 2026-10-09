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
const MAX_QUEUED_BYTES = 256 * 1024;
// String offsets count UTF-16 code units. 64 Ki code units stay below the byte
// queue cap even when every character uses three UTF-8 bytes.
const WRITE_BODY_CHUNK_BYTES = 64 * 1024;
const RESERVATION_CHUNK_BYTES = 4 * 1024 * 1024;
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
  write(chunk: Uint8Array, reservationChunkBytes = RESERVATION_CHUNK_BYTES): Promise<void> {
    if (this.stopped || this.sealed) return Promise.resolve();
    if (this.queuedBytes > 0 && this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES) {
      this.stop("backpressure_overflow");
      return Promise.resolve();
    }
    this.queuedBytes += chunk.byteLength;
    this.chain = this.chain
      .then(async () => {
        if (this.stopped) return;
        try {
          for (let offset = 0; offset < chunk.byteLength && !this.stopped; offset += 64 * 1024) {
            let part = chunk.subarray(offset, Math.min(chunk.byteLength, offset + 64 * 1024));
            const room = this.coordinator.maxFileBytes - this.rawBytes;
            if (room <= 0) {
              this.stop("size_limit");
              break;
            }
            if (part.byteLength > room) part = part.subarray(0, room);
            // reserve() checks lease ownership in SQLite. Rechecking the same
            // row for each 64 KiB gzip piece made large concurrent captures
            // issue thousands of synchronous queries on the request event loop.
            if (this.credit < part.byteLength)
              this.credit += this.coordinator.reserve(
                this.traceId,
                this.owner,
                this.attemptId,
                this.kind,
                Math.min(
                  reservationChunkBytes,
                  this.coordinator.maxFileBytes - this.rawBytes - this.credit
                )
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
  private closePromise: Promise<void> | undefined;
  private closeOwner(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const fd = this.fd;
    this.fd = undefined;
    const output = this.output;
    this.closePromise = output
      ? new Promise<void>((resolve) => {
          if (output.closed) {
            resolve();
            return;
          }
          output.once("close", resolve);
          // Node's WriteStream owns this descriptor after construction, including
          // error destruction even when autoClose=false. Never close its number twice.
          output.destroy();
        })
      : Promise.resolve().then(() => {
          if (fd !== undefined) fs.closeSync(fd);
        });
    return this.closePromise;
  }
  async writeBody(body: string | Uint8Array): Promise<void> {
    if (this.stopped || this.sealed) return;
    const bodyBytes = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
    if (bodyBytes > 0) {
      const fileRemaining = Math.max(
        0,
        this.coordinator.maxFileBytes - this.rawBytes - this.credit
      );
      const bodyBytesNeedingCredit = Math.max(0, bodyBytes - this.credit);
      const reservationTarget = Math.min(
        bodyBytesNeedingCredit,
        RESERVATION_CHUNK_BYTES,
        fileRemaining
      );
      if (reservationTarget > 0) {
        try {
          this.credit += this.coordinator.reserve(
            this.traceId,
            this.owner,
            this.attemptId,
            this.kind,
            reservationTarget
          );
        } catch (error) {
          this.stop(
            error instanceof Error && error.message === "lease_lost" ? "lease_lost" : "write_error"
          );
          return;
        }
      }
    }

    if (typeof body !== "string") {
      for (
        let offset = 0;
        offset < body.byteLength && !this.stopped;
        offset += WRITE_BODY_CHUNK_BYTES
      )
        await this.write(
          body.subarray(offset, offset + WRITE_BODY_CHUNK_BYTES),
          Math.min(RESERVATION_CHUNK_BYTES, body.byteLength - offset)
        );
      return;
    }
    // Preserve UTF-8 across JavaScript surrogate boundaries without duplicating the whole body.
    let byteOffset = 0;
    for (let offset = 0; offset < body.length && !this.stopped;) {
      let end = Math.min(body.length, offset + WRITE_BODY_CHUNK_BYTES);
      if (
        end < body.length &&
        body.charCodeAt(end - 1) >= 0xd800 &&
        body.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      const chunk = Buffer.from(body.slice(offset, end), "utf8");
      await this.write(chunk, Math.min(RESERVATION_CHUNK_BYTES, bodyBytes - byteOffset));
      byteOffset += chunk.byteLength;
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
      await this.closeOwner();
      if (this.failure) throw this.failure;
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
      try {
        await this.closeOwner();
      } catch {
        /* Capture remains incomplete. */
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
