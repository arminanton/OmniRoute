-- Per-save physical IDs are reserved before asynchronous artifact writes. Only
-- published identities join completed call_logs; existing rows/links are unchanged.
-- Lookup keys are fixed-size SHA-256 digests of the caller's full ID (not prefixes).
CREATE TABLE IF NOT EXISTS call_log_identities (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  physical_id TEXT NOT NULL UNIQUE,
  lookup_key TEXT,
  logical_key TEXT,
  owner_pid INTEGER NOT NULL,
  owner_scope TEXT,
  created_at INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_cli_lookup ON call_log_identities(lookup_key, published, ordinal);
CREATE INDEX IF NOT EXISTS idx_cli_logical ON call_log_identities(logical_key, published, ordinal);
CREATE INDEX IF NOT EXISTS idx_cli_pending ON call_log_identities(published, owner_scope, ordinal);

-- Covers retention, row caps, API/compliance purges, and old-version DELETEs.
-- A foreign key cannot do this because a reservation precedes its call_logs row.
CREATE TRIGGER IF NOT EXISTS call_logs_delete_identity
AFTER DELETE ON call_logs
BEGIN
  DELETE FROM call_log_identities WHERE physical_id = OLD.id;
END;
