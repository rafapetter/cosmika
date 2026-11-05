-- Audit log filtered by user and period (PoC item 13).
CREATE INDEX IF NOT EXISTS "AuditLog_accountId_actorId_createdAt_idx" ON "AuditLog"("accountId", "actorId", "createdAt");
