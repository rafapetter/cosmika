-- Remember which Anthropic `tool_use` block a queued call answers, so the
-- confirm flow can write the matching `tool_result` back into the session
-- history. Nullable: rows created before this migration have no id to recover.
ALTER TABLE "AgentToolCall" ADD COLUMN "toolUseId" TEXT;
