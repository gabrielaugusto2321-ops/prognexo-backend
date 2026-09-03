-- =====================================================================
-- FASE 2.2 — Criptografia de tokens/credenciais em repouso (ADITIVA).
--
-- Só ESTRUTURA. Nada é criptografado em SQL — a cifragem acontece no backend
-- (src/lib/credentialVault.js) e a migração de dados existentes é feita pelo
-- script scripts/migrate-token-encryption.js.
--
-- NÃO remove access_token / refresh_token / webhook_token (plaintext permanece
-- nesta fase). Rollback em 0009_token_encryption.rollback.sql remove só o que
-- esta migration adiciona.
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto nesta fase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Colunas aditivas — nullable, sem default.
-- ---------------------------------------------------------------------
alter table public.integrations  add column if not exists access_token_encrypted   text;
alter table public.integrations  add column if not exists webhook_token_encrypted  text;
alter table public.integrations  add column if not exists webhook_token_lookup     text;
alter table public.integrations  add column if not exists token_encryption_migrated_at timestamptz;

alter table public.google_tokens add column if not exists access_token_encrypted   text;
alter table public.google_tokens add column if not exists refresh_token_encrypted  text;
alter table public.google_tokens add column if not exists token_encryption_migrated_at timestamptz;

-- ---------------------------------------------------------------------
-- 2. Constraints de formato do envelope: "e1.v<N>.<iv>.<ct>.<tag>".
--    Não valida a cripto — só barra lixo óbvio / gravação acidental de plaintext.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'integrations_access_token_enc_fmt') then
    alter table public.integrations add constraint integrations_access_token_enc_fmt
      check (access_token_encrypted is null or access_token_encrypted ~ '^e1\.v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'integrations_webhook_token_enc_fmt') then
    alter table public.integrations add constraint integrations_webhook_token_enc_fmt
      check (webhook_token_encrypted is null or webhook_token_encrypted ~ '^e1\.v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'integrations_webhook_lookup_fmt') then
    alter table public.integrations add constraint integrations_webhook_lookup_fmt
      check (webhook_token_lookup is null or webhook_token_lookup ~ '^[A-Za-z0-9_-]{43,44}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'google_tokens_access_token_enc_fmt') then
    alter table public.google_tokens add constraint google_tokens_access_token_enc_fmt
      check (access_token_encrypted is null or access_token_encrypted ~ '^e1\.v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'google_tokens_refresh_token_enc_fmt') then
    alter table public.google_tokens add constraint google_tokens_refresh_token_enc_fmt
      check (refresh_token_encrypted is null or refresh_token_encrypted ~ '^e1\.v[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Índice para o blind index (lookup por digest). NUNCA no ciphertext.
-- ---------------------------------------------------------------------
create index if not exists integrations_webhook_token_lookup_idx
  on public.integrations (gateway, webhook_token_lookup)
  where webhook_token_lookup is not null;

-- ---------------------------------------------------------------------
-- 4. RLS / grants — reafirma o fechamento do 0008 (idempotente).
--    O navegador continua SEM select nessas tabelas; as colunas novas
--    herdam o revoke de tabela. Nenhuma função SQL recebe chave de cripto.
-- ---------------------------------------------------------------------
revoke select on public.integrations  from anon, authenticated;
revoke select on public.google_tokens from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Views de status — passam a considerar ciphertext OU plaintext, para
--    continuarem corretas durante e depois da migração. Continuam sem
--    projetar nenhum valor de token.
-- ---------------------------------------------------------------------
create or replace view public.google_connection_status
with (security_invoker = off) as
  select g.user_id,
         (g.refresh_token is not null or g.refresh_token_encrypted is not null) as connected,
         g.expiry as expires_at,
         (g.calendar_id is not null) as has_calendar
  from public.google_tokens g
  where g.user_id = auth.uid();
grant select on public.google_connection_status to authenticated;
revoke all on public.google_connection_status from anon;

create or replace view public.integration_status
with (security_invoker = off) as
  select i.id, i.organization_id, i.doctor_id, i.gateway, i.external_id,
         (i.access_token is not null  or i.access_token_encrypted is not null)  as has_access_token,
         (i.webhook_token is not null or i.webhook_token_encrypted is not null) as has_webhook_token,
         (i.token_encryption_migrated_at is not null) as token_encryption_migrated
  from public.integrations i
  where public.is_doctor_owner(i.doctor_id)
     or (i.organization_id is not null and public.is_org_member(i.organization_id))
     or public.is_platform_admin();
grant select on public.integration_status to authenticated;
revoke all on public.integration_status from anon;
