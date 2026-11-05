-- AI spend outside the agent orchestrator (a flow's AI block, the GUIDED
-- deviation classifier) has no agent bot behind it, but the account's monthly
-- AI budget is summed over AiAgentSession. Allowing a session with no bot lets
-- that spend be recorded against the account instead of being invisible.
ALTER TABLE "AiAgentSession" ALTER COLUMN "agentBotId" DROP NOT NULL;
