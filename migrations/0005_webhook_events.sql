-- FASE 1A/R05/R07: durable webhook idempotency ledger. REVIEW; DO NOT auto-apply.
create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_event_id text not null,
  signature_valid boolean not null,
  payload_hash text not null,
  status text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, external_event_id)
);
alter table public.webhook_events enable row level security;
revoke all on public.webhook_events from anon, authenticated;
