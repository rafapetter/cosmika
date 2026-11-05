-- Closing message per inbox (pilot, item 08).
--
-- Sent to the contact when an agent resolves a conversation, before the CSAT
-- survey. Nullable and without backfill: NULL means "send nothing", which is
-- what every inbox does today.

ALTER TABLE "Inbox" ADD COLUMN IF NOT EXISTS "closingMessage" TEXT;
