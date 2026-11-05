-- Automatic distribution can hand a conversation to someone who is off shift,
-- because leaving it ownerless after telling the contact a human is coming is
-- worse. That is a coverage hole, and somebody who can fix it has to hear about
-- it; the agent who received it already gets an ordinary ASSIGNMENT.
--
-- Adding a value to an existing enum is additive and does not rewrite the
-- table. Postgres allows it outside a transaction block from 12 onward; Prisma
-- runs each migration in its own transaction, so IF NOT EXISTS keeps this
-- re-runnable rather than needing to be split out.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_FALLBACK';
