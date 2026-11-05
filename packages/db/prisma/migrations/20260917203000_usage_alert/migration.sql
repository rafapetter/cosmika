-- One row per alert already sent. The unique key is the whole point: it makes
-- "at most one of each warning per account per month" a database guarantee,
-- so a retry, a second API instance or a restart mid-sweep cannot fill a
-- customer's mailbox with the same warning.
CREATE TABLE "UsageAlert" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "UsageAlert_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageAlert_accountId_month_kind_key" ON "UsageAlert"("accountId", "month", "kind");
CREATE INDEX "UsageAlert_accountId_month_idx" ON "UsageAlert"("accountId", "month");

ALTER TABLE "UsageAlert" ADD CONSTRAINT "UsageAlert_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
