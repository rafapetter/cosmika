-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "adminAgentRequiresApproval" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "AdminAgentSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "state" JSONB NOT NULL,
    "totalTokensIn" INTEGER NOT NULL DEFAULT 0,
    "totalTokensOut" INTEGER NOT NULL DEFAULT 0,
    "totalCostUsd" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminAgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAgentToolCall" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "errorMessage" TEXT,
    "status" "ToolCallStatus" NOT NULL,
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAgentToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAgentSession_accountId_userId_lastActiveAt_idx" ON "AdminAgentSession"("accountId", "userId", "lastActiveAt");

-- CreateIndex
CREATE INDEX "AdminAgentToolCall_sessionId_createdAt_idx" ON "AdminAgentToolCall"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAgentToolCall_status_idx" ON "AdminAgentToolCall"("status");

-- AddForeignKey
ALTER TABLE "AdminAgentSession" ADD CONSTRAINT "AdminAgentSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAgentSession" ADD CONSTRAINT "AdminAgentSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAgentToolCall" ADD CONSTRAINT "AdminAgentToolCall_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AdminAgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

