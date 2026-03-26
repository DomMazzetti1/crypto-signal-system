-- Add delivery tracking columns to decisions table.
-- Tracks whether Telegram send was attempted and succeeded.

alter table decisions add column if not exists telegram_attempted boolean default false;
alter table decisions add column if not exists telegram_sent boolean default false;
alter table decisions add column if not exists telegram_error text;
alter table decisions add column if not exists blocked_reason text;
