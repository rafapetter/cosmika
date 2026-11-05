-- NPS 0 to 10 next to CSAT 1 to 5 (PoC item 14).
DO $$ BEGIN
  CREATE TYPE "SurveyType" AS ENUM ('CSAT', 'NPS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "surveyType" "SurveyType" NOT NULL DEFAULT 'CSAT';

ALTER TABLE "CsatSurvey" ADD COLUMN IF NOT EXISTS "type" "SurveyType" NOT NULL DEFAULT 'CSAT';
ALTER TABLE "CsatSurvey" ADD COLUMN IF NOT EXISTS "teamId" TEXT;

CREATE INDEX IF NOT EXISTS "CsatSurvey_accountId_type_respondedAt_idx" ON "CsatSurvey"("accountId", "type", "respondedAt");
