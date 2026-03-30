alter table production_signal_grades
  add column if not exists close_at_48h_price numeric;

alter table production_signal_grades
  add column if not exists sl_moved_to_tp2 boolean default false;
