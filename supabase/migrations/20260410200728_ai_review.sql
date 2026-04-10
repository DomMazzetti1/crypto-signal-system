-- Add ai_review JSONB column to decisions table.
-- Stores the full Sonnet AI signal review (confidence, pattern, verdict,
-- dynamic TPs, suggested stop, concerns, reasoning).
-- Old Haiku columns (claude_decision, claude_confidence, etc.) are preserved
-- for historical data but are no longer populated.
--
-- DO NOT APPLY without Yuri sign-off.

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS ai_review JSONB;

CREATE INDEX IF NOT EXISTS idx_decisions_ai_verdict
  ON decisions ((ai_review->>'overall_verdict'));
