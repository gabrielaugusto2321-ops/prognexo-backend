-- Rollback ESTRUTURAL da 0011. Não destrói webhook_token nem nenhum segredo.
-- Restaura a view integration_status ao formato do 0010 e remove os metadados
-- de rotação + a tabela de auditoria.

-- create-or-replace não remove colunas do fim de uma view; recria.
drop view if exists public.integration_status;
create view public.integration_status
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

drop table if exists public.webhook_token_events;

alter table public.integrations drop constraint if exists integrations_webhook_fingerprint_fmt;
alter table public.integrations drop column if exists webhook_token_rotated_at;
alter table public.integrations drop column if exists webhook_token_fingerprint;
