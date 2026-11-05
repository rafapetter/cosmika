-- Meta WhatsApp Business-Scoped User IDs (2026 usernames rollout):
-- second identity key on ContactInbox next to the phone-based sourceId.

-- AlterTable
ALTER TABLE "ContactInbox" ADD COLUMN "bsuid" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ContactInbox_inboxId_bsuid_key" ON "ContactInbox"("inboxId", "bsuid");
