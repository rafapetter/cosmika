-- Round robin state for automatic conversation distribution: when routing last
-- gave this member a conversation. The next conversation goes to the available
-- member who has waited longest. Nullable and without a default, so adding it
-- is a metadata-only change and existing members start as "never assigned".
ALTER TABLE "AccountMember" ADD COLUMN "lastAutoAssignedAt" TIMESTAMP(3);
