alter table production_signal_grades
  add column if not exists close_at_48h_price numeric;
