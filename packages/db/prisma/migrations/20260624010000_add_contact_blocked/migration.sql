-- Add a block flag to Contact. NULL = not blocked; a timestamp = blocked at that time.
ALTER TABLE "Contact" ADD COLUMN "blockedAt" TIMESTAMP(3);
