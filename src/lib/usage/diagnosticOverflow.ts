import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveDataDir } from "../dataPaths";
import { DiagnosticOverflowCoordinator } from "./diagnosticOverflowCoordinator";
import { DiagnosticOverflowWriter } from "./diagnosticOverflowWriter";
import {
  privateDirectory,
  privateFile,
  fileName,
  safeMetadata,
  safeReason,
  safeRequestId,
  syncDirectory,
} from "./diagnosticOverflowFilesystem";
import {
  DIAGNOSTIC_ID,
  DIAGNOSTIC_OVERFLOW_SCHEMA,
  type DiagnosticOverflowOptions,
  type DiagnosticOverflowAttemptMetadata,
  type DiagnosticOverflowReference,
  type DiagnosticOverflowManifest,
  type DiagnosticOverflowReadResult,
  type DiagnosticOverflowReadKind,
  type DiagnosticOverflowKind,
} from "./diagnosticOverflowTypes";
export * from "./diagnosticOverflowTypes";
const STATE_KEY = Symbol.for("omniroute.diagnosticOverflow.state.v1");
interface DiagnosticOverflowProcessState {
  active: Set<string>;
  stores: Map<string, DiagnosticOverflowStore>;
}
const processRegistry = globalThis as typeof globalThis & {
  [key: symbol]: DiagnosticOverflowProcessState | undefined;
};
const processState = (processRegistry[STATE_KEY] ??= {
  active: new Set<string>(),
  stores: new Map<string, DiagnosticOverflowStore>(),
});
const activeCaptures = processState.active;
export const getActiveDiagnosticOverflowCount = () => activeCaptures.size;
const emptyFile = () => ({
  state: "capturing" as const,
  complete: false,
  rawBytes: 0,
  compressedBytes: 0,
});
export class DiagnosticOverflowAttempt {
  readonly id: string;
  private response: DiagnosticOverflowWriter | undefined;
  private done = false;
  constructor(
    private trace: DiagnosticOverflowTrace,
    id: string
  ) {
    this.id = id;
  }
  async initialize(body: string | Uint8Array): Promise<void> {
    const request = this.trace.writer(this.id, "provider_request");
    if (request) {
      await request.writeBody(body);
      await request.seal(true);
    }
    this.response = this.trace.writer(this.id, "provider_response");
  }
  acceptingResponse(): boolean {
    return this.response?.accepting() ?? false;
  }
  async writeResponse(chunk: Uint8Array): Promise<void> {
    try {
      await this.response?.write(chunk);
    } catch {
      this.trace.markIncomplete("write_error");
    }
  }
  async finish(metadata: DiagnosticOverflowAttemptMetadata = {}): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.trace.attemptMetadata(this.id, metadata);
    await this.response?.seal(true);
  }
  async fail(reason: string, metadata: DiagnosticOverflowAttemptMetadata = {}): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.trace.attemptMetadata(this.id, metadata);
    await this.response?.seal(false, safeReason(reason));
    this.trace.markIncomplete(reason);
  }
}
export class DiagnosticOverflowTrace {
  readonly traceId: string;
  private owner: string;
  private state: "capturing" | "complete" | "incomplete" = "capturing";
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private writers: DiagnosticOverflowWriter[] = [];
  private attempts: DiagnosticOverflowAttempt[] = [];
  private finishPromise: Promise<void> | undefined;
  private done = false;
  private reason: string | undefined;
  constructor(
    private coordinator: DiagnosticOverflowCoordinator | undefined,
    record?: { id: string; owner: string },
    failure?: string
  ) {
    this.traceId = record?.id ?? randomUUID();
    this.owner = record?.owner ?? randomUUID();
    if (!coordinator || !record) {
      this.coordinator = undefined;
      this.state = "incomplete";
      this.reason = failure ?? "aggregate_budget";
      return;
    }
    activeCaptures.add(this.traceId);
    this.heartbeat = setInterval(
      () => {
        try {
          coordinator.renew(this.traceId, this.owner);
        } catch {
          this.markIncomplete("lease_lost");
          void this.abort("lease_lost");
        }
      },
      Math.max(1, Math.min(10000, Math.floor(coordinator.leaseMs / 3)))
    );
    this.heartbeat.unref();
  }
  snapshot(): DiagnosticOverflowReference {
    return {
      schema: DIAGNOSTIC_OVERFLOW_SCHEMA,
      traceId: this.traceId,
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      ...(!this.coordinator ? { persisted: false } : {}),
    };
  }
  markIncomplete(reason: string): void {
    this.state = "incomplete";
    this.reason ??= safeReason(reason);
    try {
      this.coordinator?.markIncomplete(this.traceId, this.owner, reason);
    } catch {}
  }
  writer(id: string, kind: DiagnosticOverflowKind): DiagnosticOverflowWriter | undefined {
    if (!this.coordinator || this.done) return undefined;
    const writer = new DiagnosticOverflowWriter(
      this.coordinator,
      this.traceId,
      this.owner,
      id,
      kind,
      (reason) => this.markIncomplete(reason)
    );
    this.writers.push(writer);
    return writer;
  }
  async writeClientRequest(body: string | Uint8Array): Promise<void> {
    try {
      const writer = this.writer(this.traceId, "client_request");
      if (writer) {
        await writer.writeBody(body);
        await writer.seal(true);
      }
    } catch {
      this.markIncomplete("write_error");
    }
  }
  async beginAttempt(
    input: DiagnosticOverflowAttemptMetadata & { requestBody: string | Uint8Array }
  ): Promise<DiagnosticOverflowAttempt> {
    const id = randomUUID(),
      attempt = new DiagnosticOverflowAttempt(this, id);
    if (this.attempts.length >= 32) {
      this.markIncomplete("attempt_limit");
      return attempt;
    }
    this.attempts.push(attempt);
    try {
      this.coordinator?.mutate(this.traceId, this.owner, (manifest) =>
        manifest.attempts.push({
          attemptId: id,
          ...safeMetadata(input),
          request: emptyFile(),
          response: emptyFile(),
        })
      );
      await attempt.initialize(input.requestBody);
    } catch {
      this.markIncomplete("write_error");
    }
    return attempt;
  }
  attemptMetadata(id: string, input: DiagnosticOverflowAttemptMetadata): void {
    try {
      this.coordinator?.mutate(this.traceId, this.owner, (manifest) => {
        const attempt = manifest.attempts.find((item) => item.attemptId === id);
        if (attempt) {
          const update = safeMetadata(input);
          Object.assign(attempt, update, { headers: { ...attempt.headers, ...update.headers } });
        }
      });
    } catch {
      this.markIncomplete("write_error");
    }
  }
  finish(): Promise<void> {
    this.finishPromise ??= this.finishInternal();
    return this.finishPromise;
  }
  private async finishInternal(): Promise<void> {
    if (this.done) return;
    this.done = true;
    for (const writer of this.writers) await writer.seal(false, this.reason ?? "missing_eof");
    try {
      const manifest = this.coordinator?.sealTrace(this.traceId, this.owner);
      if (manifest) this.state = manifest.state;
    } catch {
      this.markIncomplete("write_error");
    }
    if (this.heartbeat) clearInterval(this.heartbeat);
    activeCaptures.delete(this.traceId);
  }
  async abort(reason = "abort"): Promise<void> {
    if (this.done) return;
    this.markIncomplete(reason);
    for (const attempt of this.attempts) await attempt.fail(reason);
    await this.finish();
  }
}
export class DiagnosticOverflowStore {
  readonly coordinator: DiagnosticOverflowCoordinator;
  constructor(options: DiagnosticOverflowOptions) {
    this.coordinator = new DiagnosticOverflowCoordinator(path.resolve(options.root), options);
  }
  createTrace(input: { provider: string; requestId?: string }): DiagnosticOverflowTrace {
    try {
      privateDirectory(this.coordinator.root, false);
      const record = this.coordinator.create(
        /^[a-z0-9_-]{1,64}$/i.test(input.provider) ? input.provider : "unknown",
        safeRequestId(input.requestId)
      );
      return new DiagnosticOverflowTrace(this.coordinator, record ?? undefined);
    } catch {
      return new DiagnosticOverflowTrace(undefined, undefined, "capture_error");
    }
  }
  read(traceId: string): DiagnosticOverflowManifest | null {
    if (!DIAGNOSTIC_ID.test(traceId)) return null;
    try {
      return this.coordinator.manifest(traceId);
    } catch {
      return null;
    }
  }
  list(options: { limit?: number; before?: number } = {}): DiagnosticOverflowManifest[] {
    const rows = this.coordinator.db
      .prepare(
        "SELECT id FROM traces WHERE json_extract(manifest,'$.createdAt')<? ORDER BY json_extract(manifest,'$.createdAt') DESC LIMIT ?"
      )
      .all(
        options.before ?? Number.MAX_SAFE_INTEGER,
        Math.max(1, Math.min(100, options.limit ?? 20))
      ) as Array<{ id: string }>;
    return rows
      .map((row) => this.read(row.id))
      .filter((value): value is DiagnosticOverflowManifest => value !== null);
  }
  open(
    traceId: string,
    attemptId: string,
    readKind: DiagnosticOverflowReadKind
  ): DiagnosticOverflowReadResult {
    if (!DIAGNOSTIC_ID.test(traceId) || !DIAGNOSTIC_ID.test(attemptId)) return { state: "missing" };
    const kind: DiagnosticOverflowKind | undefined = (
      {
        "client-request": "client_request",
        request: "provider_request",
        response: "provider_response",
        client_request: "client_request",
        provider_request: "provider_request",
        provider_response: "provider_response",
      } as const
    )[readKind];
    if (!kind || (kind === "client_request" && attemptId !== traceId)) return { state: "missing" };
    const manifest = this.read(traceId);
    if (!manifest) return { state: "missing" };
    const metadata =
      kind === "client_request"
        ? manifest.clientRequest
        : manifest.attempts.find((attempt) => attempt.attemptId === attemptId)?.[
            kind === "provider_request" ? "request" : "response"
          ];
    if (!metadata) return { state: "missing" };
    if (metadata.state === "capturing") return { state: "capturing", metadata };
    try {
      privateDirectory(this.coordinator.root, false);
      const directory = path.join(this.coordinator.root, traceId);
      privateDirectory(directory, false);
      const filename = path.join(directory, fileName(attemptId, kind));
      privateFile(filename);
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (stat.size !== metadata.compressedBytes || !metadata.sha256 || !metadata.gzipSha256) {
        fs.closeSync(fd);
        return { state: "corrupt", metadata };
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (offset < stat.size) {
        const count = fs.readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, stat.size - offset),
          offset
        );
        if (!count) break;
        hash.update(buffer.subarray(0, count));
        offset += count;
      }
      if (offset !== stat.size || hash.digest("hex") !== metadata.gzipSha256) {
        fs.closeSync(fd);
        return { state: "corrupt", metadata };
      }
      return {
        state: "ready",
        metadata,
        stream: fs.createReadStream("", { fd, start: 0, autoClose: true }),
      };
    } catch {
      return { state: "corrupt", metadata };
    }
  }
  cleanup(now = Date.now()): void {
    const expired = this.coordinator.db
      .prepare("SELECT id FROM traces WHERE lease_until>0 AND lease_until<?")
      .all(now) as Array<{ id: string }>;
    for (const row of expired)
      this.coordinator.transaction(() => {
        const current = this.coordinator.row(row.id);
        if (!current || current.lease_until <= 0 || current.lease_until >= now) return;
        const manifest = JSON.parse(current.manifest) as DiagnosticOverflowManifest;
        manifest.state = "incomplete";
        manifest.reasons.push("writer_lease_expired");
        manifest.sealedAt = now;
        this.coordinator.db
          .prepare("UPDATE traces SET owner=?,lease_until=0,manifest=? WHERE id=?")
          .run(randomUUID(), JSON.stringify(manifest), row.id);
        this.coordinator.db
          .prepare(
            "UPDATE files SET metadata=json_set(metadata,'$.state','incomplete','$.complete',json('false'),'$.reason','writer_lease_expired') WHERE trace_id=? AND json_extract(metadata,'$.state')='capturing'"
          )
          .run(row.id);
      });
    const eligible = this.coordinator.db
      .prepare(
        "SELECT id FROM traces WHERE lease_until=0 AND json_extract(manifest,'$.sealedAt')<? ORDER BY json_extract(manifest,'$.sealedAt') LIMIT 100"
      )
      .all(now - this.coordinator.retentionMs) as Array<{ id: string }>;
    for (const row of eligible) {
      const manifest = this.read(row.id);
      if (!manifest || !manifest.sealedAt) continue;
      this.coordinator.transaction(() => {
        const current = this.coordinator.row(manifest.traceId);
        if (!current || current.lease_until !== 0) return;
        const directory = path.join(this.coordinator.root, manifest.traceId);
        privateDirectory(directory, false);
        const files = this.coordinator.db
          .prepare("SELECT attempt_id,kind FROM files WHERE trace_id=?")
          .all(manifest.traceId) as Array<{ attempt_id: string; kind: DiagnosticOverflowKind }>;
        for (const file of files) {
          const filename = path.join(directory, fileName(file.attempt_id, file.kind));
          if (fs.existsSync(filename)) {
            privateFile(filename);
            fs.unlinkSync(filename);
          }
        }
        fs.rmdirSync(directory);
        syncDirectory(this.coordinator.root);
        this.coordinator.db.prepare("DELETE FROM files WHERE trace_id=?").run(manifest.traceId);
        this.coordinator.db.prepare("DELETE FROM traces WHERE id=?").run(manifest.traceId);
      });
    }
  }
  close(): void {
    this.coordinator.close();
  }
}
function defaultStore(readOnly = false): DiagnosticOverflowStore | undefined {
  const root = path.join(resolveDataDir(), "diagnostic_overflow");
  const existing = processState.stores.get(root);
  if (existing) return existing;
  if (readOnly && !fs.existsSync(path.join(root, "coordination.sqlite"))) return undefined;
  const integer = (name: string, fallback: number) =>
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  const store = new DiagnosticOverflowStore({
    root,
    maxFileBytes: integer("OMNI_DIAGNOSTIC_OVERFLOW_FILE_BYTES", 64 * 1024 * 1024),
    maxTotalBytes: integer("OMNI_DIAGNOSTIC_OVERFLOW_TOTAL_BYTES", 2 * 1024 * 1024 * 1024),
    retentionMs: integer("OMNI_DIAGNOSTIC_OVERFLOW_RETENTION_MS", 7 * 86400000),
  });
  processState.stores.set(root, store);
  return store;
}
export async function createDiagnosticOverflowTrace(input: {
  eligible: boolean;
  provider: string;
  requestId?: string;
}): Promise<DiagnosticOverflowTrace | null> {
  if (!input.eligible || process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED !== "true") return null;
  try {
    const store = defaultStore();
    try {
      store?.cleanup();
    } catch {
      /* Retention failures do not stop new eligible capture. */
    }
    return (
      store?.createTrace(input) ??
      new DiagnosticOverflowTrace(undefined, undefined, "capture_error")
    );
  } catch {
    return new DiagnosticOverflowTrace(undefined, undefined, "capture_error");
  }
}
export async function readDiagnosticOverflowManifest(
  traceId: string
): Promise<DiagnosticOverflowManifest | null> {
  try {
    return defaultStore(true)?.read(traceId) ?? null;
  } catch {
    return null;
  }
}
export async function listDiagnosticOverflowTraces(
  options: { limit?: number; before?: number } = {}
): Promise<DiagnosticOverflowManifest[]> {
  try {
    return defaultStore(true)?.list(options) ?? [];
  } catch {
    return [];
  }
}
export async function openDiagnosticOverflowFile(
  traceId: string,
  attemptId: string,
  kind: DiagnosticOverflowReadKind
): Promise<DiagnosticOverflowReadResult> {
  try {
    return defaultStore(true)?.open(traceId, attemptId, kind) ?? { state: "missing" };
  } catch {
    return { state: "corrupt" };
  }
}

export function getDiagnosticOverflowActiveWork(): number | null {
  if (activeCaptures.size) return activeCaptures.size;
  return process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED === "true" &&
    !processState.stores.has(path.join(resolveDataDir(), "diagnostic_overflow"))
    ? null
    : 0;
}
export async function initializeDiagnosticOverflowStore(): Promise<boolean> {
  if (process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED !== "true") return true;
  try {
    return !!defaultStore();
  } catch {
    return false;
  }
}
