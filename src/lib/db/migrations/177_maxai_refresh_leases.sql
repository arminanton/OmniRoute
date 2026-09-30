-- MaxAI refresh tokens may rotate. Never expire an unresolved sent generation:
-- a lost response, process crash, or restored rotated-away token must not repost it.
-- Only an explicitly settled no-rotation response can permit exact-snapshot reuse.
-- No credential plaintext or ciphertext is duplicated in this table.
CREATE TABLE IF NOT EXISTS maxai_refresh_leases (
  connection_id TEXT NOT NULL,
  generation TEXT NOT NULL CHECK (length(generation) = 64),
  owner TEXT NOT NULL,
  credential_snapshot TEXT NOT NULL CHECK (length(credential_snapshot) = 64),
  -- Only a settled NO-ROTATION response can authorize reuse, and only against
  -- the exact post-commit cipher snapshot. Rotated-away generations stay spent.
  reusable_snapshot TEXT CHECK (reusable_snapshot IS NULL OR length(reusable_snapshot) = 64),
  lease_expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('acquired', 'sent', 'quarantined', 'committed')),
  sent_at INTEGER,
  failure_code TEXT CHECK (
    failure_code IS NULL OR failure_code IN (
      'refresh_uncertain', 'refresh_expired', 'refresh_conflict'
    )
  ),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, generation)
);
-- Deliberately no cascading FK: deleting/recreating a connection must not erase
-- the evidence that a particular refresh token was already sent.
