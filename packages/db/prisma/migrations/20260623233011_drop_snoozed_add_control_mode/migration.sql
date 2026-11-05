-- Drop SNOOZED from ConversationStatus + add the Bot/Human control axis.
--
-- SNOOZED was a dead feature (the snooze AI-tool set it but nothing ever woke
-- a snoozed conversation). Convert any existing snoozed rows back to OPEN
-- BEFORE recreating the enum, otherwise the enum-cast below fails on them.
UPDATE "Conversation" SET "status" = 'OPEN' WHERE "status" = 'SNOOZED';

-- CreateEnum
CREATE TYPE "ControlMode" AS ENUM ('BOT', 'HUMAN');

-- AlterEnum: ConversationStatus loses SNOOZED
BEGIN;
CREATE TYPE "ConversationStatus_new" AS ENUM ('OPEN', 'RESOLVED', 'PENDING');
ALTER TABLE "Conversation" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Conversation" ALTER COLUMN "status" TYPE "ConversationStatus_new" USING ("status"::text::"ConversationStatus_new");
ALTER TYPE "ConversationStatus" RENAME TO "ConversationStatus_old";
ALTER TYPE "ConversationStatus_new" RENAME TO "ConversationStatus";
DROP TYPE "ConversationStatus_old";
ALTER TABLE "Conversation" ALTER COLUMN "status" SET DEFAULT 'OPEN';
COMMIT;

-- AlterTable: add controlMode (default HUMAN; backfilled below for bot-handled convos)
ALTER TABLE "Conversation" ADD COLUMN "controlMode" "ControlMode" NOT NULL DEFAULT 'HUMAN';

-- Backfill: a conversation is bot-controlled when its inbox has an agent bot
-- in an auto-reply mode AND no human is assigned yet.
UPDATE "Conversation" c
SET "controlMode" = 'BOT'
FROM "Inbox" i
WHERE c."inboxId" = i."id"
  AND i."agentBotId" IS NOT NULL
  AND i."aiAutoreplyMode" IN ('AUTO_SAFE', 'AUTO_FULL')
  AND c."assigneeId" IS NULL
  AND c."status" <> 'RESOLVED';

-- CreateIndex
CREATE INDEX "Conversation_accountId_controlMode_idx" ON "Conversation"("accountId", "controlMode");
