-- 026: Add ai_review JSONB column to decisions table
-- Replaces old Haiku reviewer fields with structured Sonnet AI review data.
-- Old columns (claude_decision, claude_confidence, claude_request, claude_response)
-- are kept for historical data but will no longer be populated.

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS ai_review jsonb;

-- Index on confidence for future querying (e.g., WHERE (ai_review->>'confidence')::int > 70)
CREATE INDEX IF NOT EXISTS idx_decisions_ai_review_confidence
  ON decisions (((ai_review->>'confidence')::int));

-- Index on pattern for pattern analysis (e.g., GROUP BY ai_review->>'pattern')
CREATE INDEX IF NOT EXISTS idx_decisions_ai_review_pattern
  ON decisions ((ai_review->>'pattern'));

-- Index on verdict for filtering strong vs avoid signals
CREATE INDEX IF NOT EXISTS idx_decisions_ai_review_verdict
  ON decisions ((ai_review->>'overall_verdict'));
