-- Conversation.lastMessageAt: when a real message last landed.
--
-- The inbox previously sorted by `updatedAt`, which Prisma bumps on ANY row
-- write (labels, assignments, bulk migration/maintenance). After the Nebula
-- import and bulk control-mode updates, that column no longer bore any
-- relation to conversation activity, so the list appeared unsorted: a 2021
-- thread could outrank yesterday's.
ALTER TABLE "Conversation" ADD COLUMN "lastMessageAt" TIMESTAMP(3);

-- Backfill from real history. Activity notes are excluded (contentAttributes
-- carries an `activity` key) so administrative actions never define a
-- conversation's activity time.
UPDATE "Conversation" c
SET "lastMessageAt" = m.last_at
FROM (
  SELECT "conversationId", MAX("createdAt") AS last_at
  FROM "Message"
  WHERE NOT (COALESCE("contentAttributes", '{}'::jsonb) ? 'activity')
  GROUP BY "conversationId"
) m
WHERE m."conversationId" = c.id;

-- Conversations with no messages at all fall back to their creation time so
-- they still sort sensibly instead of sinking to the bottom forever.
UPDATE "Conversation"
SET "lastMessageAt" = "createdAt"
WHERE "lastMessageAt" IS NULL;

CREATE INDEX "Conversation_accountId_lastMessageAt_idx"
  ON "Conversation"("accountId", "lastMessageAt");
