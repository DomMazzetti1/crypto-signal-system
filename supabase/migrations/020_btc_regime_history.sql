-- btc_regime_history: daily BTC regime classification
CREATE TABLE IF NOT EXISTS btc_regime_history (
  date DATE NOT NULL PRIMARY KEY,
  close NUMERIC NOT NULL,
  ema200 NUMERIC,
  adx14 NUMERIC,
  regime TEXT NOT NULL,
  distance_to_ema200_pct NUMERIC,
  transition_zone BOOLEAN DEFAULT FALSE,
  regime_age_days INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add regime_production column to backtest_signals
ALTER TABLE backtest_signals ADD COLUMN IF NOT EXISTS regime_production TEXT;
