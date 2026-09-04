-- =====================================================================
-- FASE 2.4 — Ciclo de vida do webhook_token (ADITIVA).
--
-- Adiciona só metadados para rotação segura + tabela de auditoria.
-- NÃO remove nem altera webhook_token / webhook_token_encrypted /
-- webhook_token_lookup. O token atual (default do banco) segue válido até a
-- primeira rotação explícita via POST /integrations/:id/webhook-token/rotate.
-- Idempotente. Rollback em 0011_webhook_token_lifecycle.rollback.sql.
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Metadados de rotação em integrations (nullable, sem default).
--    fingerprint = hash NÃO-REVERSÍVEL curto, só para a UI distinguir tokens.
-- ---------------------------------------------------------------------
alter table public.integrations add column if not exists webhook_token_rotated_at   timestamptz;
alter table public.integrations add column if not exists webhook_token_fingerprint  text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'integrations_webhook_fingerprint_fmt') then
    alter table public.integrations add constraint integrations_webhook_fingerprint_fmt
      check (webhook_token_fingerprint is null or webhook_token_fingerprint ~ '^[a-f0-9]{6,32}$');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Auditoria da rotação. NUNCA contém o token — só quem/quando/qual/resultado.
--    Backend-only (service-role). Sem policy = deny-all para anon/authenticated.
-- ---------------------------------------------------------------------
create table if not exists public.webhook_token_events (
  id              uuid primary key default gen_random_uuid(),
  integration_id  uuid not null references public.integrations(id) on delete cascade,
  organization_id uuid references public.organizations(id) on delete set null,
  actor_user_id   uuid references public.users(id) on delete set null,
  gateway         text not null,
  action          text not null default 'rotate' check (action in ('rotate')),
  result          text not null check (result in ('success','denied','error','conflict')),
  detail          jsonb not null default '{}'::jsonb,   -- nunca guarda o token
  created_at      timestamptz not null default now()
);
create index if not exists webhook_token_events_integration_idx on public.webhook_token_events (integration_id);
create index if not exists webhook_token_events_org_idx on public.webhook_token_events (organization_id);

alter table public.webhook_token_events enable row level security;
revoke all on public.webhook_token_events from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. View de status — expõe só ESTADO da rotação, nunca o token.
--    Reescreve integration_status (do 0009/0010) somando os campos novos.
-- ---------------------------------------------------------------------
create or replace view public.integration_status
with (security_invoker = off) as
  select i.id, i.organization_id, i.doctor_id, i.gateway, i.external_id,
         (i.access_token is not null  or i.access_token_encrypted is not null)  as has_access_token,
         (i.webhook_token is not null or i.webhook_token_encrypted is not null) as has_webhook_token,
         (i.token_encryption_migrated_at is not null) as token_encryption_migrated,
         i.webhook_token_fingerprint,
         i.webhook_token_rotated_at
  from public.integrations i
  where public.is_doctor_owner(i.doctor_id)
     or (i.organization_id is not null and public.is_org_member(i.organization_id))
     or public.is_platform_admin();
grant select on public.integration_status to authenticated;
revoke all on public.integration_status from anon;
