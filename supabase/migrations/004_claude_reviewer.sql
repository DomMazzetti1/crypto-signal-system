create table prompt_versions (
  id uuid primary key default gen_random_uuid(),
  prompt_version text not null unique,
  model_name text not null,
  model_snapshot text,
  system_prompt text not null,
  output_schema jsonb not null,
  is_production boolean not null default false,
  parent_prompt_version text,
  notes text,
  created_at timestamptz default now()
);

alter table decisions add column prompt_version_id
  uuid references prompt_versions(id);
alter table decisions add column claude_request jsonb;
alter table decisions add column claude_response jsonb;
alter table decisions add column claude_decision text;
alter table decisions add column claude_confidence int;

-- Seed initial prompt version
insert into prompt_versions (
  prompt_version,
  model_name,
  model_snapshot,
  system_prompt,
  output_schema,
  is_production,
  notes
) values (
  'v1.0',
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-20250514',
  'You are a crypto signal reviewer.
You do not create trades.
You do not invent price levels.
You review candidates that already passed deterministic checks.
Return INVALID if data quality is insufficient.
Return NO_TRADE if setup is not worth forwarding.
Return LONG or SHORT only if setup is coherent, regime-aligned, and materially worth acting on.
Use only supplied fields.
Keep reasoning to 2 sentences maximum.
Do not invent facts.',
  '{
    "type": "object",
    "properties": {
      "decision": { "type": "string", "enum": ["INVALID", "NO_TRADE", "LONG", "SHORT"] },
      "confidence": { "type": "integer", "minimum": 1, "maximum": 10 },
      "setup_type": { "type": "string", "enum": ["mean_reversion", "breakout", "continuation", "reversal", "none"] },
      "level_review": {
        "type": "object",
        "properties": {
          "entry_valid": { "type": "boolean" },
          "stop_valid": { "type": "boolean" },
          "targets_valid": { "type": "boolean" }
        },
        "required": ["entry_valid", "stop_valid", "targets_valid"]
      },
      "invalid_if": { "type": "string" },
      "reasoning": { "type": "string" },
      "risk_flags": { "type": "array", "items": { "type": "string" } },
      "data_quality": { "type": "string", "enum": ["high", "medium", "low"] },
      "suggested_adjustments": {
        "type": "object",
        "properties": {
          "entry_note": { "type": "string" },
          "stop_note": { "type": "string" },
          "target_note": { "type": "string" }
        },
        "required": ["entry_note", "stop_note", "target_note"]
      }
    },
    "required": ["decision", "confidence", "setup_type", "level_review", "invalid_if", "reasoning", "risk_flags", "data_quality", "suggested_adjustments"]
  }'::jsonb,
  true,
  'Initial production prompt for Phase 4 launch'
);
