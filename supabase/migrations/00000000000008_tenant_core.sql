-- =====================================================================
-- FASE 2.1 — Núcleo multitenant ADITIVO.
--   organizations -> units -> memberships -> roles
-- Preserva 100% do modelo atual: doctor_id, todas as tabelas e colunas.
-- Não remove nem renomeia nada. Idempotente (if not exists / on conflict).
-- Rollback estrutural em 0008_tenant_core.rollback.sql (não apaga dados legados).
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tabelas novas
-- ---------------------------------------------------------------------
create table if not exists public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  status     text not null default 'active' check (status in ('active','suspended','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.units (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null,
  status          text not null default 'active' check (status in ('active','suspended','archived')),
  timezone        text not null default 'America/Sao_Paulo',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists units_org_idx on public.units (organization_id);

create table if not exists public.memberships (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  role            text not null check (role in (
                    'platform_admin','organization_owner','organization_admin','manager',
                    'closer','receptionist','professional','financial','viewer')),
  status          text not null default 'active' check (status in ('active','suspended','invited')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index if not exists memberships_user_idx on public.memberships (user_id);
create index if not exists memberships_org_idx on public.memberships (organization_id);

create table if not exists public.membership_units (
  membership_id uuid not null references public.memberships(id) on delete cascade,
  unit_id       uuid not null references public.units(id) on delete cascade,
  primary key (membership_id, unit_id)
);

create table if not exists public.organization_doctor_map (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  doctor_id       uuid not null references public.doctors(id) on delete cascade,
  default_unit_id uuid references public.units(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (doctor_id)
);
create index if not exists org_doctor_map_org_idx on public.organization_doctor_map (organization_id);

-- Ambiguidades do backfill — NUNCA escolher tenant silenciosamente.
create table if not exists public.tenant_backfill_issues (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  subject_type text not null,
  subject_id   text not null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (kind, subject_type, subject_id)
);

-- Admins de plataforma (não é membership).
create table if not exists public.platform_admins (
  user_id    uuid primary key references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. Colunas ADITIVAS nas tabelas do corte vertical (nullable — não quebra nada)
-- ---------------------------------------------------------------------
alter table public.leads        add column if not exists organization_id uuid references public.organizations(id);
alter table public.events       add column if not exists organization_id uuid references public.organizations(id);
alter table public.events       add column if not exists unit_id         uuid references public.units(id);
alter table public.campanhas    add column if not exists organization_id uuid references public.organizations(id);
alter table public.integrations add column if not exists organization_id uuid references public.organizations(id);
create index if not exists leads_org_idx on public.leads (organization_id);
create index if not exists events_org_idx on public.events (organization_id);
create index if not exists campanhas_org_idx on public.campanhas (organization_id);
create index if not exists integrations_org_idx on public.integrations (organization_id);

-- ---------------------------------------------------------------------
-- 3-10. BACKFILL — função IDEMPOTENTE.
--
-- Em produção, roda contra dados reais (doctors já existem) ao aplicar a 0008.
-- No fluxo local (`supabase db reset`), as migrations rodam ANTES do seed, então
-- o seed re-invoca `select public.backfill_tenant_core();` no final. Idempotente
-- -> chamar N vezes converge para o mesmo estado.
--
-- NUNCA escolhe tenant "principal" silenciosamente: o que não dá para mapear
-- com certeza vai para `tenant_backfill_issues` e NÃO gera membership.
-- ---------------------------------------------------------------------
create or replace function public.backfill_tenant_core()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  d record; a record; new_org uuid; new_unit uuid; org uuid; du uuid; mid uuid;
begin
  -- 3/4/5/6. org + unidade padrão + map + membership do owner, por doctor.
  for d in select * from public.doctors loop
    if exists (select 1 from public.organization_doctor_map m where m.doctor_id = d.id) then
      continue;
    end if;
    insert into public.organizations (name, slug, status)
      values (coalesce(nullif(trim(d.nome), ''), 'Organizacao ' || substr(d.id::text, 1, 8)),
              'org-' || replace(d.id::text, '-', ''), 'active')
      returning id into new_org;
    insert into public.units (organization_id, name, status, timezone)
      values (new_org, 'Unidade principal', 'active', 'America/Sao_Paulo')
      returning id into new_unit;
    insert into public.organization_doctor_map (organization_id, doctor_id, default_unit_id)
      values (new_org, d.id, new_unit);

    if d.owner_user_id is not null and exists (select 1 from public.users u where u.id = d.owner_user_id) then
      insert into public.memberships (organization_id, user_id, role, status)
        values (new_org, d.owner_user_id, 'organization_owner', 'active')
        on conflict (organization_id, user_id) do nothing;
    elsif d.owner_user_id is null then
      insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
        values ('orphan_doctor_no_owner', 'doctor', d.id::text, jsonb_build_object('organization_id', new_org))
        on conflict do nothing;
    else
      insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
        values ('owner_user_missing', 'doctor', d.id::text, jsonb_build_object('owner_user_id', d.owner_user_id))
        on conflict do nothing;
    end if;
  end loop;

  -- 7. closers (user_doctor_access) -> membership 'closer' + membership_units.
  --    Usuário ligado a N doctors -> N memberships (múltiplas orgs).
  for a in select uda.user_id, uda.doctor_id from public.user_doctor_access uda loop
    select m.organization_id, m.default_unit_id into org, du
      from public.organization_doctor_map m where m.doctor_id = a.doctor_id;
    if org is null then
      insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
        values ('access_doctor_unmapped', 'user_doctor_access', a.user_id::text, jsonb_build_object('doctor_id', a.doctor_id))
        on conflict do nothing;
      continue;
    end if;
    if not exists (select 1 from public.users u where u.id = a.user_id) then
      insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
        values ('membership_user_missing', 'user_doctor_access', a.user_id::text, jsonb_build_object('doctor_id', a.doctor_id))
        on conflict do nothing;
      continue;
    end if;
    insert into public.memberships (organization_id, user_id, role, status)
      values (org, a.user_id, 'closer', 'active')
      on conflict (organization_id, user_id) do nothing;
    select id into mid from public.memberships where organization_id = org and user_id = a.user_id;
    if mid is not null and du is not null then
      insert into public.membership_units (membership_id, unit_id) values (mid, du) on conflict do nothing;
    end if;
  end loop;

  -- 8/9. closer sem nenhum user_doctor_access -> registra, NÃO cria membership.
  insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
  select 'closer_without_access', 'user', u.id::text, '{}'::jsonb
  from public.users u
  where u.role = 'closer'
    and not exists (select 1 from public.user_doctor_access uda where uda.user_id = u.id)
  on conflict do nothing;

  -- admin global -> platform_admins.
  insert into public.platform_admins (user_id)
  select u.id from public.users u where u.role = 'admin'
  on conflict (user_id) do nothing;

  -- 10. organization_id nas tabelas do corte vertical (via map).
  update public.leads l set organization_id = m.organization_id
    from public.organization_doctor_map m
    where m.doctor_id = l.doctor_id and l.organization_id is null;
  update public.events e set organization_id = m.organization_id, unit_id = coalesce(e.unit_id, m.default_unit_id)
    from public.organization_doctor_map m
    where m.doctor_id = e.doctor_id and e.organization_id is null;
  update public.campanhas c set organization_id = m.organization_id
    from public.organization_doctor_map m
    where m.doctor_id = c.doctor_id and c.organization_id is null;
  update public.integrations i set organization_id = m.organization_id
    from public.organization_doctor_map m
    where m.doctor_id = i.doctor_id and i.organization_id is null;
end
$fn$;

revoke execute on function public.backfill_tenant_core() from anon, authenticated;

-- Roda 1x ao aplicar a migration (em produção já pega os doctors reais).
select public.backfill_tenant_core();

-- ---------------------------------------------------------------------
-- 11/14/15. Funções auxiliares de tenancy (SECURITY DEFINER, search_path fixo,
-- EXECUTE só authenticated).
-- ---------------------------------------------------------------------
create or replace function public.is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.memberships m
    where m.organization_id = target_org and m.user_id = auth.uid() and m.status = 'active'
  );
$$;

create or replace function public.has_org_role(target_org uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(
    select 1 from public.memberships m
    where m.organization_id = target_org and m.user_id = auth.uid()
      and m.status = 'active' and m.role = any(allowed_roles)
  );
$$;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.platform_admins p where p.user_id = auth.uid())
      or exists(select 1 from public.users u where u.id = auth.uid() and u.role = 'admin');
$$;

revoke execute on function public.is_org_member(uuid) from anon;
revoke execute on function public.has_org_role(uuid, text[]) from anon;
revoke execute on function public.is_platform_admin() from anon;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.has_org_role(uuid, text[]) to authenticated;
grant execute on function public.is_platform_admin() to authenticated;

-- ---------------------------------------------------------------------
-- 12. RLS nas tabelas novas
-- ---------------------------------------------------------------------
alter table public.organizations           enable row level security;
alter table public.units                   enable row level security;
alter table public.memberships             enable row level security;
alter table public.membership_units        enable row level security;
alter table public.organization_doctor_map enable row level security;
alter table public.tenant_backfill_issues  enable row level security;
alter table public.platform_admins         enable row level security;

-- só a service-role acessa map/issues/platform_admins (sem policy = deny-all p/ browser)
revoke all on public.organization_doctor_map from anon, authenticated;
revoke all on public.tenant_backfill_issues  from anon, authenticated;
revoke all on public.platform_admins         from anon, authenticated;

create policy org_member_read on public.organizations
  for select using (public.is_org_member(id) or public.is_platform_admin());
create policy org_owner_admin_write on public.organizations
  for update using (public.has_org_role(id, array['organization_owner','organization_admin']) or public.is_platform_admin());

create policy unit_member_read on public.units
  for select using (public.is_org_member(organization_id) or public.is_platform_admin());
create policy unit_owner_admin_write on public.units
  for all using (public.has_org_role(organization_id, array['organization_owner','organization_admin']) or public.is_platform_admin());

create policy membership_self_read on public.memberships
  for select using (user_id = auth.uid());
create policy membership_org_admin_read on public.memberships
  for select using (public.has_org_role(organization_id, array['organization_owner','organization_admin']) or public.is_platform_admin());
-- Escrita de membership: owner/admin da org ou platform admin PODEM gerenciar,
-- mas NÃO podem escalar privilégio — org_admin só concede papéis abaixo dele,
-- e ninguém além do platform admin cria membership 'platform_admin'.
create policy membership_org_admin_write on public.memberships
  for all using (public.has_org_role(organization_id, array['organization_owner','organization_admin']) or public.is_platform_admin())
  with check (
    public.is_platform_admin()
    or (public.has_org_role(organization_id, array['organization_owner'])
        and role <> 'platform_admin')
    or (public.has_org_role(organization_id, array['organization_admin'])
        and role in ('manager','closer','receptionist','professional','financial','viewer'))
  );

create policy membership_units_read on public.membership_units
  for select using (exists (
    select 1 from public.memberships m
    where m.id = membership_units.membership_id
      and (m.user_id = auth.uid() or public.has_org_role(m.organization_id, array['organization_owner','organization_admin']) or public.is_platform_admin())
  ));

-- ---------------------------------------------------------------------
-- 13 (parte). Policies ADITIVAS e EQUIVALENTES no corte vertical.
-- Não removem as policies antigas (doctor_scoped_*) — são OR'd; como o backfill
-- mantém membership <=> ownership, não há acesso novo.
-- ---------------------------------------------------------------------
create policy leads_org_scoped on public.leads
  for all
  using (organization_id is not null and public.is_org_member(organization_id))
  with check (organization_id is not null and public.is_org_member(organization_id));

create policy leads_org_admin_all on public.leads
  for all using (public.is_platform_admin());

create policy events_org_scoped on public.events
  for all
  using (organization_id is not null and public.is_org_member(organization_id))
  with check (organization_id is not null and public.is_org_member(organization_id));

create policy campanhas_org_scoped on public.campanhas
  for all
  using (organization_id is not null and public.is_org_member(organization_id))
  with check (organization_id is not null and public.is_org_member(organization_id));

-- deals: tenant via leads (deals não tem organization_id própria)
create policy deals_org_scoped on public.deals
  for all
  using (exists (
    select 1 from public.leads l
    where l.id = deals.lead_id and l.organization_id is not null and public.is_org_member(l.organization_id)
  ))
  with check (exists (
    select 1 from public.leads l
    where l.id = deals.lead_id and l.organization_id is not null and public.is_org_member(l.organization_id)
  ));

-- ---------------------------------------------------------------------
-- AR-2 — closer não escreve colunas arbitrárias de lead pelo PostgREST.
-- O frontend NÃO escreve direto em leads (auditoria 18 §5). Toda escrita passa
-- pela API (service-role). Aqui: revoga INSERT/DELETE do browser e restringe
-- UPDATE às colunas que a aplicação legitimamente deixa o closer editar.
-- ---------------------------------------------------------------------
revoke insert, delete on public.leads from anon, authenticated;
revoke update on public.leads from anon, authenticated;
grant update (status_atual, dados_extraidos) on public.leads to authenticated;

-- ---------------------------------------------------------------------
-- AR-3 (contenção) — navegador não lê colunas de token.
-- Views seguras retornam só ESTADO (nunca o token).
-- ---------------------------------------------------------------------
revoke select on public.google_tokens from anon, authenticated;
revoke select on public.integrations  from anon, authenticated;

create or replace view public.google_connection_status
with (security_invoker = off) as
  select g.user_id,
         (g.refresh_token is not null) as connected,
         g.expiry as expires_at,
         (g.calendar_id is not null) as has_calendar
  from public.google_tokens g
  where g.user_id = auth.uid();
grant select on public.google_connection_status to authenticated;

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

-- garante que anon nunca veja as views
revoke all on public.google_connection_status from anon;
revoke all on public.integration_status from anon;
