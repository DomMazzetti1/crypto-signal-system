-- Track when the execution engine actually opened a position on Bybit
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS exec_opened_at timestamptz;
