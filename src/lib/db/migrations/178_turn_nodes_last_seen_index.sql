-- 178_turn_nodes_last_seen_index.sql
-- Add index on conversation_turn_nodes(last_seen_at) to enable fast retention pruning
-- without full table scans on large multi-million row node histories.
CREATE INDEX IF NOT EXISTS idx_turn_nodes_last_seen
  ON conversation_turn_nodes(last_seen_at);
