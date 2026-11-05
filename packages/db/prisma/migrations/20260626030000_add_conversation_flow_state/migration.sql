-- Deterministic-flow runtime state (position + variables) per conversation.
ALTER TABLE "Conversation" ADD COLUMN "flowState" JSONB;
