-- Backtest results table for historical analysis
CREATE TABLE IF NOT EXISTS backtest_results (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  backtest_run_id TEXT NOT NULL,
  backtest_run_date TIMESTAMPTZ DEFAULT NOW(),
  symbol TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  tier TEXT,
  direction TEXT NOT NULL,
  btc_regime TEXT,
  entry_price NUMERIC,
  stop_price NUMERIC,
  tp1_price NUMERIC,
  tp2_price NUMERIC,
  tp3_price NUMERIC,
  signal_created_at TIMESTAMPTZ,
  graded_outcome TEXT,
  outcome_r NUMERIC,
  resolution_path TEXT,
  hit_tp1 BOOLEAN,
  hit_tp2 BOOLEAN,
  hit_tp3 BOOLEAN,
  hit_sl BOOLEAN,
  bars_to_resolution INTEGER,
  max_favorable NUMERIC,
  max_adverse NUMERIC,
  close_at_48h_price NUMERIC,
  composite_score NUMERIC,
  vol_ratio NUMERIC,
  bb_width NUMERIC,
  rsi NUMERIC,
  adx_1h NUMERIC,
  atr_pct NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_backtest_run_id ON backtest_results(backtest_run_id);
CREATE INDEX IF NOT EXISTS idx_backtest_regime ON backtest_results(btc_regime);
CREATE INDEX IF NOT EXISTS idx_backtest_outcome ON backtest_results(graded_outcome);

-- Account state table for kill switch
CREATE TABLE IF NOT EXISTS account_state (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  week_start_date DATE NOT NULL UNIQUE,
  high_water_mark_usd NUMERIC NOT NULL,
  current_equity_usd NUMERIC NOT NULL,
  kill_switch_active BOOLEAN DEFAULT FALSE,
  kill_switch_reason TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add risk_check_result to decisions table
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS risk_check_result JSONB;
