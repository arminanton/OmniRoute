import { getDbInstance, rowToCamel, objToSnake } from "./core";
import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { DEFAULT_BATCH_EXPIRATION_SECONDS } from "@/shared/constants/batch";

export interface FileRecord {
  id: string;
  bytes: number;
  createdAt: number;
  filename: string;
  purpose: string;
  content?: Buffer | null;
  mimeType?: string | null;
  apiKeyId?: string | null;
  expiresAt?: number | null;
  deletedAt?: number | null;
}

const FILE_METADATA_COLUMNS =
  "id, bytes, created_at, filename, purpose, mime_type, api_key_id, expires_at, deleted_at";

export const VIDEO_TASK_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const VIDEO_TASK_ARTIFACT_OWNER_BUDGET_BYTES = 256 * 1024 * 1024;
export const VIDEO_TASK_ARTIFACT_GLOBAL_BUDGET_BYTES = 512 * 1024 * 1024;
export const VIDEO_TASK_ARTIFACT_RETENTION_SECONDS = 24 * 60 * 60;
const VIDEO_TASK_FILE_PURPOSE = "video_task";

export function getVideoTaskArtifactId(taskId: string): string {
  if (typeof taskId !== "string" || !taskId.trim() || taskId.length > 128) {
    throw new Error("invalid_video_task_id");
  }
  return `file-vt-${createHash("sha256").update(taskId).digest("hex").slice(0, 32)}`;
}

export function findVideoTaskArtifact(
  taskId: string,
  apiKeyId: string,
  now = Math.floor(Date.now() / 1000)
) {
  const file = getFile(getVideoTaskArtifactId(taskId));
  if (
    !file ||
    file.purpose !== VIDEO_TASK_FILE_PURPOSE ||
    file.apiKeyId !== apiKeyId ||
    (file.expiresAt != null && file.expiresAt <= now)
  ) {
    return null;
  }
  const content = getFileContent(file.id);
  return content ? { ...file, content } : null;
}

/** Persist a bounded, private video result under a stable task-derived file ID. */
export function createVideoTaskArtifact(input: {
  taskId: string;
  apiKeyId: string;
  content: Buffer;
  mimeType?: string | null;
  now?: number;
}): FileRecord {
  if (typeof input.taskId !== "string" || !input.taskId.trim() || input.taskId.length > 128) {
    throw new Error("invalid_video_task_id");
  }
  if (typeof input.apiKeyId !== "string" || !input.apiKeyId.trim() || input.apiKeyId.length > 512) {
    throw new Error("invalid_video_task_owner");
  }
  if (!Buffer.isBuffer(input.content) || input.content.length < 1) {
    throw new Error("invalid_video_task_artifact");
  }
  if (input.content.length > VIDEO_TASK_ARTIFACT_MAX_BYTES) {
    throw new Error("video_task_artifact_too_large");
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid_video_task_artifact_time");
  const id = getVideoTaskArtifactId(input.taskId);
  const expiresAt = now + VIDEO_TASK_ARTIFACT_RETENTION_SECONDS;
  const extension = input.mimeType === "application/octet-stream" ? "bin" : "mp4";
  const filename = `video-task-${createHash("sha256").update(input.taskId).digest("hex").slice(0, 16)}.${extension}`;
  const db = getDbInstance();
  let created!: FileRecord;

  db.immediate(() => {
    const existingRow = db.prepare(`SELECT ${FILE_METADATA_COLUMNS} FROM files WHERE id=?`).get(id);
    if (existingRow) {
      const existing = rowToCamel(existingRow) as unknown as FileRecord;
      const existingContentLength = Number(
        (
          db.prepare("SELECT length(content) AS content_length FROM files WHERE id=?").get(id) as
            { content_length?: number } | undefined
        )?.content_length ?? 0
      );
      if (existing.purpose !== VIDEO_TASK_FILE_PURPOSE || existing.apiKeyId !== input.apiKeyId) {
        throw new Error("video_task_artifact_id_conflict");
      }
      if (
        !existing.deletedAt &&
        existingContentLength > 0 &&
        (existing.expiresAt == null || existing.expiresAt > now)
      ) {
        created = existing;
        return;
      }
    }

    const ownerBytes = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(bytes),0) AS bytes FROM files
         WHERE purpose=? AND api_key_id=? AND deleted_at IS NULL AND expires_at>? AND id!=?`
          )
          .get(VIDEO_TASK_FILE_PURPOSE, input.apiKeyId, now, id) as { bytes?: number } | undefined
      )?.bytes ?? 0
    );
    const totalBytes = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(bytes),0) AS bytes FROM files
         WHERE purpose=? AND deleted_at IS NULL AND expires_at>? AND id!=?`
          )
          .get(VIDEO_TASK_FILE_PURPOSE, now, id) as { bytes?: number } | undefined
      )?.bytes ?? 0
    );
    if (
      ownerBytes + input.content.length > VIDEO_TASK_ARTIFACT_OWNER_BUDGET_BYTES ||
      totalBytes + input.content.length > VIDEO_TASK_ARTIFACT_GLOBAL_BUDGET_BYTES
    ) {
      throw new Error("video_task_artifact_budget_exceeded");
    }

    if (existingRow) {
      db.prepare(
        `UPDATE files SET bytes=?,created_at=?,filename=?,purpose=?,content=?,mime_type=?,api_key_id=?,
         expires_at=?,deleted_at=NULL WHERE id=?`
      ).run(
        input.content.length,
        now,
        filename,
        VIDEO_TASK_FILE_PURPOSE,
        input.content,
        input.mimeType || "video/mp4",
        input.apiKeyId,
        expiresAt,
        id
      );
    } else {
      db.prepare(
        `INSERT INTO files (id,bytes,created_at,filename,purpose,content,mime_type,api_key_id,expires_at,deleted_at)
         VALUES (?,?,?,?,?,?,?,?,?,NULL)`
      ).run(
        id,
        input.content.length,
        now,
        filename,
        VIDEO_TASK_FILE_PURPOSE,
        input.content,
        input.mimeType || "video/mp4",
        input.apiKeyId,
        expiresAt
      );
    }
    created = {
      id,
      bytes: input.content.length,
      createdAt: now,
      filename,
      purpose: VIDEO_TASK_FILE_PURPOSE,
      content: input.content,
      mimeType: input.mimeType || "video/mp4",
      apiKeyId: input.apiKeyId,
      expiresAt,
      deletedAt: null,
    };
  });

  return created;
}

/** Best-effort bounded cleanup for expired video artifacts. */
export function deleteExpiredVideoTaskArtifacts(
  now = Math.floor(Date.now() / 1000),
  limit = 32
): number {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 256
  ) {
    throw new Error("invalid_video_task_artifact_cleanup");
  }
  const db = getDbInstance();
  let deleted = 0;
  db.immediate(() => {
    const rows = db
      .prepare(
        `SELECT id FROM files WHERE purpose=? AND deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at<=?
       ORDER BY expires_at ASC LIMIT ?`
      )
      .all(VIDEO_TASK_FILE_PURPOSE, now, limit) as Array<{ id: string }>;
    const remove = db.prepare(
      "UPDATE files SET deleted_at=?,content=NULL WHERE id=? AND deleted_at IS NULL"
    );
    for (const row of rows) deleted += Number(remove.run(now, row.id).changes);
  });
  return deleted;
}

export function createFile(file: Omit<FileRecord, "id" | "createdAt">): FileRecord {
  const db = getDbInstance();
  const id = "file-" + uuidv4().replaceAll("-", "").substring(0, 24);
  const createdAt = Math.floor(Date.now() / 1000);

  let expiresAt = file.expiresAt;
  if (expiresAt === undefined && file.purpose === "batch") {
    // Default: batch files expire after 30 days
    expiresAt = createdAt + DEFAULT_BATCH_EXPIRATION_SECONDS;
  }

  const record: FileRecord = {
    id,
    bytes: file.bytes,
    createdAt,
    filename: file.filename,
    purpose: file.purpose,
    content: file.content ?? null,
    mimeType: file.mimeType ?? null,
    apiKeyId: file.apiKeyId ?? null,
    expiresAt: expiresAt ?? null,
    deletedAt: null,
  };

  db.prepare(
    `
    INSERT INTO files (id, bytes, created_at, filename, purpose, content, mime_type, api_key_id, expires_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    record.id,
    record.bytes,
    record.createdAt,
    record.filename,
    record.purpose,
    record.content,
    record.mimeType,
    record.apiKeyId,
    record.expiresAt,
    record.deletedAt
  );

  return record;
}

export function getFile(id: string): FileRecord | null {
  const db = getDbInstance();
  const row = db
    .prepare(`SELECT ${FILE_METADATA_COLUMNS} FROM files WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  return row ? (rowToCamel(row) as unknown as FileRecord) : null;
}

export function getFileContent(id: string): Buffer | null {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT content FROM files WHERE id = ? AND deleted_at IS NULL")
    .get(id) as { content: Buffer | Uint8Array | string | null } | undefined;
  if (!row?.content) return null;
  return Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
}

export function listFiles(
  options: {
    apiKeyId?: string;
    purpose?: string;
    limit?: number;
    after?: string;
    order?: "asc" | "desc";
  } = {}
): FileRecord[] {
  const db = getDbInstance();
  const { apiKeyId, purpose, limit = 20, after, order = "desc" } = options;

  let query = `SELECT ${FILE_METADATA_COLUMNS} FROM files WHERE deleted_at IS NULL`;
  const params: any[] = [];

  if (apiKeyId) {
    query += " AND api_key_id = ?";
    params.push(apiKeyId);
  }

  if (purpose) {
    query += " AND purpose = ?";
    params.push(purpose);
  }

  if (after) {
    // Get the creation time of the 'after' file to use for pagination
    const afterFile = getFile(after);
    if (afterFile) {
      if (order === "desc") {
        query += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      } else {
        query += " AND (created_at > ? OR (created_at = ? AND id > ?))";
      }
      params.push(afterFile.createdAt, afterFile.createdAt, after);
    }
  }

  query += ` ORDER BY created_at ${order === "asc" ? "ASC" : "DESC"}, id ${order === "asc" ? "ASC" : "DESC"}`;
  query += " LIMIT ?";
  params.push(limit);

  const rows = db.prepare(query).all(...params);
  return rows.map((row) => rowToCamel(row) as unknown as FileRecord);
}

export function countFiles(options: { apiKeyId?: string; purpose?: string } = {}): number {
  const db = getDbInstance();
  const { apiKeyId, purpose } = options;
  let query = "SELECT COUNT(*) as c FROM files WHERE deleted_at IS NULL";
  const params: any[] = [];
  if (apiKeyId) {
    query += " AND api_key_id = ?";
    params.push(apiKeyId);
  }
  if (purpose) {
    query += " AND purpose = ?";
    params.push(purpose);
  }
  const row = db.prepare(query).get(...params) as { c: number } | undefined;
  return row ? Number(row.c) : 0;
}

export function formatFileResponse(file: FileRecord) {
  // Ensure numeric date fields are valid numbers to avoid NaN in API responses
  const createdAt =
    typeof file.createdAt === "number" && Number.isFinite(file.createdAt) ? file.createdAt : 0;
  const expiresAt =
    typeof file.expiresAt === "number" && Number.isFinite(file.expiresAt) ? file.expiresAt : null;

  return {
    id: file.id,
    bytes: file.bytes,
    created_at: createdAt,
    filename: file.filename,
    object: "file",
    purpose: file.purpose,
    expires_at: expiresAt,
  };
}

export function deleteFile(id: string): boolean {
  const db = getDbInstance();
  const result = db
    .prepare("UPDATE files SET deleted_at = ?, content = NULL WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), id);
  return result.changes > 0;
}
