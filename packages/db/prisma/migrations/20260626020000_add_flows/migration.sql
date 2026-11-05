-- Deterministic conversation flows (hybrid flow + AI agent).
CREATE TYPE "FlowStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "FlowMode" AS ENUM ('OFF', 'STRICT', 'GUIDED');

CREATE TABLE "Flow" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "FlowStatus" NOT NULL DEFAULT 'DRAFT',
    "definition" JSONB NOT NULL,
    "published" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Flow_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Flow_accountId_idx" ON "Flow"("accountId");
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Inbox: which flow the bot runs, and how it blends with the AI agent.
ALTER TABLE "Inbox" ADD COLUMN "defaultFlowId" TEXT;
ALTER TABLE "Inbox" ADD COLUMN "flowMode" "FlowMode" NOT NULL DEFAULT 'OFF';
CREATE INDEX "Inbox_defaultFlowId_idx" ON "Inbox"("defaultFlowId");
ALTER TABLE "Inbox" ADD CONSTRAINT "Inbox_defaultFlowId_fkey" FOREIGN KEY ("defaultFlowId") REFERENCES "Flow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
