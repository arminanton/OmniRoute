-- Per-API-key ordered connection preference; empty preserves normal routing.
ALTER TABLE api_keys ADD COLUMN preferred_connections TEXT NOT NULL DEFAULT '[]';
