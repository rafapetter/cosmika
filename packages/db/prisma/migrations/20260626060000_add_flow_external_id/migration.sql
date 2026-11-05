-- Source-system id for migrated flows; Cosmoflow-link sub-flows resolve by it.
ALTER TABLE "Flow" ADD COLUMN "externalId" TEXT;

-- A given account can't have two flows mapping to the same source id.
-- (NULLs are distinct in Postgres, so non-migrated flows are unconstrained.)
CREATE UNIQUE INDEX "Flow_accountId_externalId_key" ON "Flow"("accountId", "externalId");
