-- Speed up the assistant's `search_conversations`, which does an
-- ILIKE '%term%' over Message.content. On the CosmoBots account that is a
-- sequential scan over 367k rows (~1.8s) and it only grows.
--
-- A btree index cannot serve a leading-wildcard LIKE; a trigram GIN index can.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- IF NOT EXISTS matters: on an existing production database this index is
-- built separately with CREATE INDEX CONCURRENTLY (which cannot run inside a
-- migration's transaction) so that building it never blocks inbound message
-- writes. This statement is then a no-op there, and still creates the index
-- on a fresh database.
CREATE INDEX IF NOT EXISTS "Message_content_trgm_idx"
  ON "Message" USING gin (content gin_trgm_ops);
