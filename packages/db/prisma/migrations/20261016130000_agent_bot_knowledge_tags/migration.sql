-- Knowledge base per AI agent (pilot, item 03).
--
-- An agent answers only from articles that carry at least one of its tags,
-- so three agents on one account (Financeiro, Cadastro, Atendimento) can each
-- have a base of their own. Empty array = the whole account base, which is
-- exactly how every existing agent behaves today, so no backfill.

ALTER TABLE "AgentBot" ADD COLUMN IF NOT EXISTS "knowledgeTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
