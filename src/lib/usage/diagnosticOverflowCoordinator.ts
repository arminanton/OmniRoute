import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  DIAGNOSTIC_OVERFLOW_SCHEMA,
  type DiagnosticOverflowOptions,
  type DiagnosticOverflowManifest,
  type DiagnosticOverflowFile,
  type DiagnosticOverflowKind,
} from "./diagnosticOverflowTypes";
import { privateDirectory, privateFile, safeReason } from "./diagnosticOverflowFilesystem";
const TRACE_OVERHEAD = 256 * 1024;
const FILE_OVERHEAD = 64 * 1024;
const EMPTY_FILE: DiagnosticOverflowFile = {
  state: "capturing",
  complete: false,
  rawBytes: 0,
  compressedBytes: 0,
};
export class DiagnosticOverflowCoordinator {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly retentionMs: number;
  readonly leaseMs: number;
  readonly db: DatabaseSync;
  constructor(
    readonly root: string,
    options: DiagnosticOverflowOptions
  ) {
    this.maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024 * 1024;
    this.retentionMs = options.retentionMs ?? 7 * 86400000;
    this.leaseMs = options.leaseMs ?? 60000;
    for (const value of [this.maxFileBytes, this.maxTotalBytes, this.retentionMs, this.leaseMs])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid_diagnostic_policy");
    privateDirectory(root);
    const filename = path.join(root, "coordination.sqlite");
    try {
      fs.closeSync(
        fs.openSync(
          filename,
          fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_RDWR,
          0o600
        )
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    privateFile(filename);
    this.db = new DatabaseSync(filename);
    // DELETE journal inherits SQLite DB permissions, and does not leave unprotected WAL companions.
    this.db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until INTEGER NOT NULL, reserved INTEGER NOT NULL, manifest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files (trace_id TEXT NOT NULL, attempt_id TEXT NOT NULL, kind TEXT NOT NULL, reserved INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(trace_id,attempt_id,kind));"
    );
    this.db.exec("PRAGMA busy_timeout=100;");
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  row(
    id: string
  ): { owner: string; lease_until: number; reserved: number; manifest: string } | undefined {
    return this.db
      .prepare("SELECT owner,lease_until,reserved,manifest FROM traces WHERE id=?")
      .get(id) as
      { owner: string; lease_until: number; reserved: number; manifest: string } | undefined;
  }
  used(): number {
    const result = this.db
      .prepare(
        "SELECT (SELECT COALESCE(SUM(reserved),0) FROM traces)+(SELECT COALESCE(SUM(reserved),0) FROM files) AS value"
      )
      .get() as { value: number };
    const filename = path.join(this.root, "coordination.sqlite");
    let databaseBytes = fs.statSync(filename).size;
    try {
      databaseBytes += fs.statSync(`${filename}-journal`).size;
    } catch {}
    return Number(result.value) + databaseBytes;
  }
  assertOwner(id: string, owner: string): DiagnosticOverflowManifest {
    const row = this.row(id);
    if (!row || row.owner !== owner || row.lease_until <= Date.now()) throw new Error("lease_lost");
    return JSON.parse(row.manifest) as DiagnosticOverflowManifest;
  }
  create(
    provider: string,
    requestId?: string
  ): { id: string; owner: string; manifest: DiagnosticOverflowManifest } | null {
    return this.transaction(() => {
      if (this.used() + TRACE_OVERHEAD > this.maxTotalBytes) return null;
      const id = randomUUID(),
        owner = randomUUID();
      const manifest: DiagnosticOverflowManifest = {
        schema: DIAGNOSTIC_OVERFLOW_SCHEMA,
        traceId: id,
        provider,
        requestId,
        createdAt: Date.now(),
        state: "capturing",
        reasons: [],
        attempts: [],
      };
      this.db
        .prepare("INSERT INTO traces VALUES(?,?,?,?,?)")
        .run(id, owner, Date.now() + this.leaseMs, TRACE_OVERHEAD, JSON.stringify(manifest));
      return { id, owner, manifest };
    });
  }
  mutate(
    id: string,
    owner: string,
    fn: (manifest: DiagnosticOverflowManifest) => void
  ): DiagnosticOverflowManifest {
    return this.transaction(() => {
      const manifest = this.assertOwner(id, owner);
      fn(manifest);
      this.db
        .prepare("UPDATE traces SET manifest=? WHERE id=? AND owner=?")
        .run(JSON.stringify(manifest), id, owner);
      return manifest;
    });
  }
  renew(id: string, owner: string): void {
    const changed = this.db
      .prepare("UPDATE traces SET lease_until=? WHERE id=? AND owner=? AND lease_until>?")
      .run(Date.now() + this.leaseMs, id, owner, Date.now());
    if (!changed.changes) throw new Error("lease_lost");
  }
  createFile(id: string, owner: string, attemptId: string, kind: DiagnosticOverflowKind): boolean {
    return this.transaction(() => {
      this.assertOwner(id, owner);
      const allowed = this.used() + FILE_OVERHEAD <= this.maxTotalBytes;
      const metadata = allowed
        ? EMPTY_FILE
        : { ...EMPTY_FILE, state: "incomplete", reason: "aggregate_budget" };
      this.db
        .prepare("INSERT INTO files VALUES(?,?,?,?,?)")
        .run(id, attemptId, kind, allowed ? FILE_OVERHEAD : 0, JSON.stringify(metadata));
      return allowed;
    });
  }
  reserve(
    id: string,
    owner: string,
    attemptId: string,
    kind: DiagnosticOverflowKind,
    requested: number
  ): number {
    return this.transaction(() => {
      this.assertOwner(id, owner);
      const room = Math.max(0, this.maxTotalBytes - this.used());
      const grant = Math.min(room, requested);
      this.db
        .prepare(
          "UPDATE files SET reserved=reserved+? WHERE trace_id=? AND attempt_id=? AND kind=?"
        )
        .run(grant, id, attemptId, kind);
      return grant;
    });
  }
  sealFile(
    id: string,
    owner: string,
    attemptId: string,
    kind: DiagnosticOverflowKind,
    metadata: DiagnosticOverflowFile
  ): void {
    this.transaction(() => {
      this.assertOwner(id, owner);
      const previous = this.db
        .prepare("SELECT reserved FROM files WHERE trace_id=? AND attempt_id=? AND kind=?")
        .get(id, attemptId, kind) as { reserved: number } | undefined;
      this.db
        .prepare(
          "UPDATE files SET metadata=?,reserved=? WHERE trace_id=? AND attempt_id=? AND kind=?"
        )
        .run(
          JSON.stringify(metadata),
          metadata.rawBytes + Math.min(FILE_OVERHEAD, previous?.reserved ?? 0),
          id,
          attemptId,
          kind
        );
    });
  }
  manifest(id: string): DiagnosticOverflowManifest | null {
    const row = this.row(id);
    if (!row) return null;
    const manifest = JSON.parse(row.manifest) as DiagnosticOverflowManifest;
    const files = this.db
      .prepare("SELECT attempt_id,kind,metadata FROM files WHERE trace_id=?")
      .all(id) as Array<{ attempt_id: string; kind: DiagnosticOverflowKind; metadata: string }>;
    for (const file of files) {
      const metadata = JSON.parse(file.metadata) as DiagnosticOverflowFile;
      if (file.kind === "client_request") manifest.clientRequest = metadata;
      else {
        const attempt = manifest.attempts.find((item) => item.attemptId === file.attempt_id);
        if (attempt) attempt[file.kind === "provider_request" ? "request" : "response"] = metadata;
      }
    }
    return manifest;
  }
  markIncomplete(id: string, owner: string, reason: string): void {
    this.mutate(id, owner, (manifest) => {
      manifest.state = "incomplete";
      const safe = safeReason(reason);
      if (!manifest.reasons.includes(safe)) manifest.reasons.push(safe);
    });
  }
  sealTrace(id: string, owner: string): DiagnosticOverflowManifest {
    return this.transaction(() => {
      this.assertOwner(id, owner);
      const manifest = this.manifest(id)!;
      const files = [
        manifest.clientRequest,
        ...manifest.attempts.flatMap((item) => [item.request, item.response]),
      ].filter((file) => file !== undefined);
      if (!files.length || files.some((file) => !file.complete)) {
        manifest.state = "incomplete";
        if (!manifest.reasons.length) manifest.reasons.push("missing_eof");
      } else if (manifest.state !== "incomplete") manifest.state = "complete";
      manifest.sealedAt = Date.now();
      this.db
        .prepare("UPDATE traces SET manifest=?,lease_until=0 WHERE id=? AND owner=?")
        .run(JSON.stringify(manifest), id, owner);
      return manifest;
    });
  }
  close(): void {
    this.db.close();
  }
}
