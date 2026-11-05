-- Welcome flow (onboarding) storage.
--
-- Two separate things on purpose:
--
-- 1. "User"."phone" is operational: the number we call or message when a
--    channel of that person's account goes down. It belongs to the person,
--    next to the name, and it is NOT a marketing list.
--
-- 2. "AccountProfile" is OUR commercial data ABOUT the customer: industry,
--    team size, what the company does, channels in use, volume, intended use
--    and expectation. It is deliberately not on "Account", which is read on
--    almost every request and shipped whole to the browser, and it has to be
--    deletable on its own without touching how the account works.
--
-- No backfill. An account with no row is an account that never started the
-- flow, which is exactly the distinction the funnel wants to measure.

ALTER TABLE "User" ADD COLUMN "phone" TEXT;

CREATE TABLE "AccountProfile" (
    "id"                  TEXT NOT NULL,
    "accountId"           TEXT NOT NULL,
    "businessIndustry"    TEXT,
    "companySize"         TEXT,
    "businessDescription" TEXT,
    "supportToday"        TEXT,
    "channelsToday"       TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conversationVolume"  TEXT,
    "intendedFeatures"    TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expectedVolume"      TEXT,
    "expectedAiShare"     TEXT,
    "version"             INTEGER NOT NULL DEFAULT 1,
    "startedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStep"            TEXT,
    "completedAt"         TIMESTAMP(3),
    "skippedAt"           TIMESTAMP(3),
    "filledByUserId"      TEXT,
    "extra"               JSONB,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountProfile_accountId_key" ON "AccountProfile"("accountId");
CREATE INDEX "AccountProfile_completedAt_idx" ON "AccountProfile"("completedAt");
CREATE INDEX "AccountProfile_businessIndustry_idx" ON "AccountProfile"("businessIndustry");

ALTER TABLE "AccountProfile" ADD CONSTRAINT "AccountProfile_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountProfile" ADD CONSTRAINT "AccountProfile_filledByUserId_fkey"
  FOREIGN KEY ("filledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
