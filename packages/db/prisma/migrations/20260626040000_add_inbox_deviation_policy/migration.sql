-- GUIDED-mode deviation handling config per inbox.
ALTER TABLE "Inbox" ADD COLUMN "deviationPolicy" TEXT NOT NULL DEFAULT 'answer_and_return';
ALTER TABLE "Inbox" ADD COLUMN "maxDeviations" INTEGER NOT NULL DEFAULT 3;
