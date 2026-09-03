-- Rollback ESTRUTURAL da 0009. Preserva 100% do plaintext (access_token,
-- refresh_token, webhook_token). Remove só o que a 0009 adicionou.

-- Views voltam ao formato do 0008 (só plaintext).
create or replace view public.google_connection_status
with (security_invoker = off) as
  select g.user_id,
         (g.refresh_token is not null) as connected,
         g.expiry as expires_at,
         (g.calendar_id is not null) as has_calendar
  from public.google_tokens g
  where g.user_id = auth.uid();
grant select on public.google_connection_status to authenticated;
revoke all on public.google_connection_status from anon;

create or replace view public.integration_status
with (security_invoker = off) as
  select i.id, i.organization_id, i.doctor_id, i.gateway, i.external_id,
         (i.access_token is not null)  as has_access_token,
         (i.webhook_token is not null) as has_webhook_token
  from public.integrations i
  where public.is_doctor_owner(i.doctor_id)
     or (i.organization_id is not null and public.is_org_member(i.organization_id))
     or public.is_platform_admin();
grant select on public.integration_status to authenticated;
revoke all on public.integration_status from anon;

drop index if exists public.integrations_webhook_token_lookup_idx;

alter table public.integrations  drop constraint if exists integrations_access_token_enc_fmt;
alter table public.integrations  drop constraint if exists integrations_webhook_token_enc_fmt;
alter table public.integrations  drop constraint if exists integrations_webhook_lookup_fmt;
alter table public.google_tokens drop constraint if exists google_tokens_access_token_enc_fmt;
alter table public.google_tokens drop constraint if exists google_tokens_refresh_token_enc_fmt;

alter table public.integrations  drop column if exists access_token_encrypted;
alter table public.integrations  drop column if exists webhook_token_encrypted;
alter table public.integrations  drop column if exists webhook_token_lookup;
alter table public.integrations  drop column if exists token_encryption_migrated_at;
alter table public.google_tokens drop column if exists access_token_encrypted;
alter table public.google_tokens drop column if exists refresh_token_encrypted;
alter table public.google_tokens drop column if exists token_encryption_migrated_at;
