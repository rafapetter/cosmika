-- Catch-up migration: brings the migration history in line with schema.prisma.
--
-- Everything below existed in schema.prisma but in no migration, because the
-- changes were made with `prisma db push` instead of `prisma migrate dev`. A
-- database built purely from migrations was therefore missing 14 tables, 4
-- enums and several columns, and the API could not boot against it.
--
-- Written idempotently (IF NOT EXISTS / duplicate_object guards / pg_constraint
-- checks) so it is also a safe no-op on a database that already has these
-- objects from db push — notably production. Applying it there records the
-- migration without changing anything.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "NotificationType" AS ENUM ('MENTION', 'ASSIGNMENT');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "CustomAttributeTarget" AS ENUM ('CONTACT', 'CONVERSATION');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "CustomAttributeType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "ArticleStatus" AS ENUM ('DRAFT', 'PUBLISHED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS     "displayId" SERIAL NOT NULL,
ADD COLUMN IF NOT EXISTS     "forwardedFromConversationId" TEXT;

-- AlterTable
ALTER TABLE "Inbox" ADD COLUMN IF NOT EXISTS     "csatEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS     "slaPolicyId" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS     "totpAttempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS     "totpRecoveryCodes" JSONB,
ADD COLUMN IF NOT EXISTS     "totpSecret" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "CannedResponse" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "shortcode" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CannedResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Label" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversationLabel" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SavedView" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "filters" JSONB NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "mentionedByUserId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CustomAttribute" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "target" "CustomAttributeTarget" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomAttributeType" NOT NULL,
    "options" JSONB,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AgentAvailability" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "openHour" INTEGER NOT NULL,
    "openMinute" INTEGER NOT NULL DEFAULT 0,
    "closeHour" INTEGER NOT NULL,
    "closeMinute" INTEGER NOT NULL DEFAULT 0,
    "closedAllDay" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AgentAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Webhook" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "CsatSurvey" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "assignedAgentId" TEXT,
    "inboxId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "promptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "rating" INTEGER,
    "comment" TEXT,

    CONSTRAINT "CsatSurvey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SlaPolicy" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstResponseLowMinutes" INTEGER NOT NULL DEFAULT 480,
    "firstResponseNormalMinutes" INTEGER NOT NULL DEFAULT 240,
    "firstResponseHighMinutes" INTEGER NOT NULL DEFAULT 60,
    "firstResponseUrgentMinutes" INTEGER NOT NULL DEFAULT 15,
    "resolutionLowMinutes" INTEGER NOT NULL DEFAULT 10080,
    "resolutionNormalMinutes" INTEGER NOT NULL DEFAULT 2880,
    "resolutionHighMinutes" INTEGER NOT NULL DEFAULT 480,
    "resolutionUrgentMinutes" INTEGER NOT NULL DEFAULT 120,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Article" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "authorId" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "ArticleStatus" NOT NULL DEFAULT 'DRAFT',
    "tags" TEXT[],
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CannedResponse_accountId_idx" ON "CannedResponse"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CannedResponse_accountId_shortcode_key" ON "CannedResponse"("accountId", "shortcode");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Label_accountId_idx" ON "Label"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Label_accountId_title_key" ON "Label"("accountId", "title");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConversationLabel_labelId_idx" ON "ConversationLabel"("labelId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ConversationLabel_conversationId_labelId_key" ON "ConversationLabel"("conversationId", "labelId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SavedView_accountId_userId_position_idx" ON "SavedView"("accountId", "userId", "position");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_accountId_userId_readAt_idx" ON "Notification"("accountId", "userId", "readAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CustomAttribute_accountId_target_position_idx" ON "CustomAttribute"("accountId", "target", "position");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CustomAttribute_accountId_target_key_key" ON "CustomAttribute"("accountId", "target", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentAvailability_accountId_memberId_idx" ON "AgentAvailability"("accountId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentAvailability_memberId_dayOfWeek_key" ON "AgentAvailability"("memberId", "dayOfWeek");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_accountId_createdAt_idx" ON "AuditLog"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AuditLog_accountId_action_createdAt_idx" ON "AuditLog"("accountId", "action", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Webhook_accountId_isActive_idx" ON "Webhook"("accountId", "isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WebhookDelivery_webhookId_createdAt_idx" ON "WebhookDelivery"("webhookId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WebhookDelivery_status_nextRetryAt_idx" ON "WebhookDelivery"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CsatSurvey_conversationId_key" ON "CsatSurvey"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CsatSurvey_token_key" ON "CsatSurvey"("token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CsatSurvey_accountId_respondedAt_idx" ON "CsatSurvey"("accountId", "respondedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CsatSurvey_accountId_inboxId_respondedAt_idx" ON "CsatSurvey"("accountId", "inboxId", "respondedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CsatSurvey_accountId_assignedAgentId_respondedAt_idx" ON "CsatSurvey"("accountId", "assignedAgentId", "respondedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SlaPolicy_accountId_idx" ON "SlaPolicy"("accountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Article_accountId_status_idx" ON "Article"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Article_accountId_slug_key" ON "Article"("accountId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApiKey_accountId_revokedAt_idx" ON "ApiKey"("accountId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_accountId_displayId_key" ON "Conversation"("accountId", "displayId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Inbox_slaPolicyId_idx" ON "Inbox"("slaPolicyId");

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Inbox_slaPolicyId_fkey'
    ) THEN
        ALTER TABLE "Inbox" ADD CONSTRAINT "Inbox_slaPolicyId_fkey" FOREIGN KEY ("slaPolicyId") REFERENCES "SlaPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CannedResponse_accountId_fkey'
    ) THEN
        ALTER TABLE "CannedResponse" ADD CONSTRAINT "CannedResponse_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Label_accountId_fkey'
    ) THEN
        ALTER TABLE "Label" ADD CONSTRAINT "Label_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ConversationLabel_conversationId_fkey'
    ) THEN
        ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ConversationLabel_labelId_fkey'
    ) THEN
        ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'SavedView_accountId_fkey'
    ) THEN
        ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'SavedView_userId_fkey'
    ) THEN
        ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Notification_accountId_fkey'
    ) THEN
        ALTER TABLE "Notification" ADD CONSTRAINT "Notification_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Notification_userId_fkey'
    ) THEN
        ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Notification_mentionedByUserId_fkey'
    ) THEN
        ALTER TABLE "Notification" ADD CONSTRAINT "Notification_mentionedByUserId_fkey" FOREIGN KEY ("mentionedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Notification_conversationId_fkey'
    ) THEN
        ALTER TABLE "Notification" ADD CONSTRAINT "Notification_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CustomAttribute_accountId_fkey'
    ) THEN
        ALTER TABLE "CustomAttribute" ADD CONSTRAINT "CustomAttribute_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'AgentAvailability_accountId_fkey'
    ) THEN
        ALTER TABLE "AgentAvailability" ADD CONSTRAINT "AgentAvailability_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'AgentAvailability_memberId_fkey'
    ) THEN
        ALTER TABLE "AgentAvailability" ADD CONSTRAINT "AgentAvailability_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AccountMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'AuditLog_accountId_fkey'
    ) THEN
        ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'AuditLog_actorId_fkey'
    ) THEN
        ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Webhook_accountId_fkey'
    ) THEN
        ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'WebhookDelivery_webhookId_fkey'
    ) THEN
        ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CsatSurvey_accountId_fkey'
    ) THEN
        ALTER TABLE "CsatSurvey" ADD CONSTRAINT "CsatSurvey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CsatSurvey_conversationId_fkey'
    ) THEN
        ALTER TABLE "CsatSurvey" ADD CONSTRAINT "CsatSurvey_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'SlaPolicy_accountId_fkey'
    ) THEN
        ALTER TABLE "SlaPolicy" ADD CONSTRAINT "SlaPolicy_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Article_accountId_fkey'
    ) THEN
        ALTER TABLE "Article" ADD CONSTRAINT "Article_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ApiKey_accountId_fkey'
    ) THEN
        ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
