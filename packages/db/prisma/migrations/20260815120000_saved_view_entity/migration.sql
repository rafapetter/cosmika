-- SavedView.entity: which record list the view belongs to. All existing rows
-- are conversations views; the default keeps them working unchanged.
ALTER TABLE "SavedView" ADD COLUMN "entity" TEXT NOT NULL DEFAULT 'CONVERSATIONS';
DROP INDEX IF EXISTS "SavedView_accountId_userId_position_idx";
CREATE INDEX "SavedView_accountId_userId_entity_position_idx"
  ON "SavedView"("accountId", "userId", "entity", "position");
