-- Add TP ladder adjusted R to grading results
ALTER TABLE production_signal_grades ADD COLUMN IF NOT EXISTS outcome_r_ladder numeric;

-- Backfill existing graded signals
UPDATE production_signal_grades SET outcome_r_ladder =
  CASE
    WHEN outcome_r = -1 THEN -1.0
    WHEN outcome_r = 0 THEN 0.0
    WHEN outcome_r = 1.5 THEN 0.50   -- TP1 only, various exits
    WHEN outcome_r = 2.5 THEN 1.32   -- TP1+TP2, approximate
    WHEN outcome_r = 4.0 THEN 2.68   -- Full TP3
    ELSE outcome_r * 0.67            -- Fallback: ~67% of full position R
  END
WHERE outcome_r_ladder IS NULL;

COMMENT ON COLUMN production_signal_grades.outcome_r_ladder IS 'R-multiple adjusted for 33/33/34 TP ladder with SL-to-breakeven after TP1';
