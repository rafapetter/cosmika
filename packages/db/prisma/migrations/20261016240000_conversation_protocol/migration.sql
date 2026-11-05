-- One service protocol across channels (pilot, item 02).
-- Nullable: existing conversations keep none until they are opened again.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "protocol" TEXT;
CREATE INDEX IF NOT EXISTS "Conversation_accountId_protocol_idx" ON "Conversation" ("accountId", "protocol");
CREATE INDEX IF NOT EXISTS "Conversation_contactId_createdAt_idx" ON "Conversation" ("contactId", "createdAt");
