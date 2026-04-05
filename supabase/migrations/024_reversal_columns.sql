-- Track original signal info for reversed trades
alter table decisions add column if not exists original_alert_type text;
alter table decisions add column if not exists original_direction text;
