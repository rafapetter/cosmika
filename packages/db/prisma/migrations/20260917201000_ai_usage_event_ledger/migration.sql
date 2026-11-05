-- The AI ledger: one row per LLM call, and the only place an AI number on an
-- invoice may come from. Mirrors Nebula's `ai_usage_events`.
--
-- `AiAgentSession.agentBotId` is ALREADY nullable by the time this runs:
-- 20260917181000_ai_session_optional_bot does that. Repeating the statement
-- here is a no-op in Postgres rather than an error, but it would be a second
-- claim on the same column in a later migration, which is how a history
-- stops explaining itself. All this migration still owes on that table is
-- the foreign key, at the bottom, which Prisma re-declares because the
-- relation became optional.
CREATE TYPE "AiUsageSource" AS ENUM ('AGENT_BOT', 'FLOW_BLOCK', 'FLOW_DEVIATION', 'ADMIN_AGENT');

CREATE TABLE "AiUsageEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationId" TEXT,
    "agentBotId" TEXT,
    "source" "AiUsageSource" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "replied" BOOLEAN NOT NULL DEFAULT false,
    "ownKey" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiUsageEvent_accountId_createdAt_idx" ON "AiUsageEvent"("accountId", "createdAt");
CREATE INDEX "AiUsageEvent_accountId_replied_createdAt_idx" ON "AiUsageEvent"("accountId", "replied", "createdAt");
CREATE INDEX "AiUsageEvent_conversationId_idx" ON "AiUsageEvent"("conversationId");

ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: deleting a conversation must not erase the billing
-- record of what the AI did in it.
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Re-declare the session → bot foreign key now that the column is optional,
-- so the migration history and the schema agree byte for byte.
ALTER TABLE "AiAgentSession" DROP CONSTRAINT "AiAgentSession_agentBotId_fkey";
ALTER TABLE "AiAgentSession" ADD CONSTRAINT "AiAgentSession_agentBotId_fkey"
  FOREIGN KEY ("agentBotId") REFERENCES "AgentBot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
