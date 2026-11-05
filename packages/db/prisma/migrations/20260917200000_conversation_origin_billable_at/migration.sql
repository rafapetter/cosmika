-- Billing needs to tell apart a conversation a CONTACT started from one the
-- account manufactured for itself. The published terms count only the former
-- as a "new conversation", and until now the meter counted every row, so a
-- broadcast to 10.000 numbers read as 10.000 new conversations.
--
--   origin      where the row came from
--   billableAt  the instant it became a billable new conversation, or null
--
-- Backfill is deliberately generous to the customer and cheap to reason
-- about: every existing row keeps its default origin INBOUND and is stamped
-- billableAt = createdAt, which reproduces exactly the counts the meter
-- reported before this migration. Nothing moves on a customer's screen the
-- day this deploys; only conversations created from here on are classified.
CREATE TYPE "ConversationOrigin" AS ENUM ('INBOUND', 'AGENT', 'BROADCAST', 'FORWARD', 'API', 'IMPORT');

ALTER TABLE "Conversation"
  ADD COLUMN "origin" "ConversationOrigin" NOT NULL DEFAULT 'INBOUND',
  ADD COLUMN "billableAt" TIMESTAMP(3);

UPDATE "Conversation" SET "billableAt" = "createdAt" WHERE "billableAt" IS NULL;

-- Forwards are the one pre-existing case we can classify with certainty, and
-- the one the terms are explicit about: the source conversation was already
-- billed, so the copy must not be billed again.
UPDATE "Conversation"
  SET "origin" = 'FORWARD', "billableAt" = NULL
  WHERE "forwardedFromConversationId" IS NOT NULL;

CREATE INDEX "Conversation_accountId_billableAt_idx" ON "Conversation"("accountId", "billableAt");
