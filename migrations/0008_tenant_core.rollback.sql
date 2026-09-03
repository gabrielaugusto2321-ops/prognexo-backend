-- Rollback ESTRUTURAL da 0008. NÃO apaga dados legados (doctor_id, leads, etc.).
-- Remove só o que a 0008 adicionou. As colunas organization_id ficam (nullable,
-- inofensivas) para não arriscar perda — descomente os DROPs se for necessário.

-- views AR-3
drop view if exists public.integration_status;
drop view if exists public.google_connection_status;

-- AR-2 / AR-3 grants -> restaura o estado do baseline (amplo). Inseguro por
-- design: só usar em emergência e refechar depois.
grant select on public.google_tokens to anon, authenticated;
grant select on public.integrations  to anon, authenticated;
grant insert, update, delete on public.leads to anon, authenticated;

-- policies aditivas do corte vertical
drop policy if exists deals_org_scoped      on public.deals;
drop policy if exists campanhas_org_scoped  on public.campanhas;
drop policy if exists events_org_scoped     on public.events;
drop policy if exists leads_org_admin_all   on public.leads;
drop policy if exists leads_org_scoped      on public.leads;

-- policies das tabelas novas
drop policy if exists membership_units_read      on public.membership_units;
drop policy if exists membership_org_admin_write on public.memberships;
drop policy if exists membership_org_admin_read  on public.memberships;
drop policy if exists membership_self_read       on public.memberships;
drop policy if exists unit_owner_admin_write     on public.units;
drop policy if exists unit_member_read           on public.units;
drop policy if exists org_owner_admin_write      on public.organizations;
drop policy if exists org_member_read            on public.organizations;

-- funções de tenancy
drop function if exists public.backfill_tenant_core();
drop function if exists public.is_platform_admin();
drop function if exists public.has_org_role(uuid, text[]);
drop function if exists public.is_org_member(uuid);

-- tabelas novas (ordem inversa de dependência) — contêm só dados de backfill,
-- reconstruíveis re-rodando a 0008.
drop table if exists public.platform_admins;
drop table if exists public.tenant_backfill_issues;
drop table if exists public.organization_doctor_map;
drop table if exists public.membership_units;
drop table if exists public.memberships;
drop table if exists public.units;
drop table if exists public.organizations cascade;  -- cascade remove os FKs organization_id

-- colunas aditivas (seguras de manter; DROP opcional)
-- alter table public.leads        drop column if exists organization_id;
-- alter table public.events       drop column if exists organization_id;
-- alter table public.events       drop column if exists unit_id;
-- alter table public.campanhas    drop column if exists organization_id;
-- alter table public.integrations drop column if exists organization_id;
