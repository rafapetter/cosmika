-- WhatsApp HSM templates, synced per inbox from the Meta Graph API.
CREATE TABLE "WhatsappTemplate" (
    "id" TEXT NOT NULL,
    "inboxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "variableCount" INTEGER NOT NULL DEFAULT 0,
    "components" JSONB NOT NULL DEFAULT '[]',
    "externalId" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WhatsappTemplate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WhatsappTemplate_inboxId_name_language_key" ON "WhatsappTemplate"("inboxId", "name", "language");
CREATE INDEX "WhatsappTemplate_inboxId_idx" ON "WhatsappTemplate"("inboxId");
ALTER TABLE "WhatsappTemplate" ADD CONSTRAINT "WhatsappTemplate_inboxId_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
