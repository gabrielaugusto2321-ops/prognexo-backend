-- =====================================================================
-- FASE 2.6 — Cutover do módulo de equipe para memberships (ADITIVA).
--
-- NÃO remove nem altera user_doctor_access, doctors.owner_user_id, users.role
-- nem nenhuma tabela/coluna legada. NÃO torna organization_id NOT NULL em
-- lugar nenhum. Idempotente (create if not exists / create or replace).
-- Rollback em 0012_team_memberships_cutover.rollback.sql.
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.
--
-- Reaproveita a base já existente da FASE 2.1 (0008_tenant_core.sql):
--   memberships, membership_units, organization_doctor_map, platform_admins,
--   is_org_member(), has_org_role(), is_platform_admin() — nada disso é
--   recriado. Esta migration adiciona só o que faltava:
--   1) tabela de auditoria de operações de equipe;
--   2) RPCs transacionais (invite/change-role/suspend-reactivate/remove/units)
--      com proteção do último owner e sincronia com a ponte user_doctor_access;
--   3) tabela de relatório de reconciliação do backfill (contagens, sem PII).
--
-- Modelo de confiança: estas RPCs são SECURITY DEFINER e chamadas SÓ pelo
-- backend via service_role (o backend não propaga JWT de usuário ao Postgres
-- — ver src/lib/supabase.js). Por isso o "ator" é recebido como parâmetro
-- (`p_actor_user_id`), sempre resolvido no backend a partir do Bearer token
-- validado (`req.user.id`, nunca do body) — o mesmo padrão já usado em
-- webhook_token_events.actor_user_id (FASE 2.4).
--
-- DEFESA EM DUAS CAMADAS (a 1ª sozinha não é suficiente neste ambiente local):
--  1) EXECUTE é revogado de anon/authenticated (só service_role chama).
--  2) Cross-check `auth.uid()` embutido em CADA função: se existe um JWT de
--     usuário de verdade na sessão (auth.uid() is not null — nunca acontece
--     na conexão service_role do backend, SEMPRE acontece se alguém chamar a
--     RPC direto via PostgREST com uma sessão anon/authenticated), a função
--     exige `auth.uid() = p_actor_user_id` (ou recusa de vez, nas que não
--     recebem ator) — ninguém consegue se passar por outro usuário mesmo que
--     o passo 1 falhe. Isso é CRÍTICO: sem essa camada, `p_actor_user_id` é
--     só um parâmetro posicional — um chamador direto poderia alegar ser
--     qualquer um. A camada 2 fecha esse buraco independentemente da 1.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Auditoria de operações de equipe. NUNCA nome/e-mail/telefone — só IDs,
--    papel/status (não é segredo) e resultado.
-- ---------------------------------------------------------------------
create table if not exists public.team_membership_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid references public.organizations(id) on delete set null,
  actor_user_id    uuid references public.users(id) on delete set null,
  target_user_id   uuid references public.users(id) on delete set null,
  action           text not null check (action in ('add','change_role','suspend','reactivate','remove','set_units')),
  result           text not null check (result in ('success','denied','error')),
  detail           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists team_membership_events_org_idx on public.team_membership_events (organization_id);
create index if not exists team_membership_events_target_idx on public.team_membership_events (target_user_id);

alter table public.team_membership_events enable row level security;
revoke all on public.team_membership_events from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Relatório de reconciliação do backfill (ETAPA 6). Só contagens/IDs
--    técnicos — nunca token/telefone/e-mail/dado clínico.
-- ---------------------------------------------------------------------
create table if not exists public.team_backfill_reconciliation (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid references public.organizations(id) on delete set null,
  only_legacy_count     int not null default 0,
  only_membership_count int not null default 0,
  suspended_divergence  int not null default 0,
  classification        text not null check (classification in ('match','divergent','unmapped')),
  created_at            timestamptz not null default now()
);
create index if not exists team_backfill_reconciliation_org_idx on public.team_backfill_reconciliation (organization_id);

alter table public.team_backfill_reconciliation enable row level security;
revoke all on public.team_backfill_reconciliation from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Papel efetivo do ator numa organização. Nunca por JWT/claims — sempre
--    lido de memberships/platform_admins no momento da chamada.
-- ---------------------------------------------------------------------
create or replace function public.team_actor_role(p_organization_id uuid, p_actor_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_role text;
  v_is_platform_admin boolean;
begin
  if auth.uid() is not null and auth.uid() <> p_actor_user_id then raise exception 'forbidden'; end if;
  select exists(select 1 from public.platform_admins pa where pa.user_id = p_actor_user_id)
      or exists(select 1 from public.users u where u.id = p_actor_user_id and u.role = 'admin')
    into v_is_platform_admin;
  if v_is_platform_admin then
    return 'platform_admin';
  end if;

  select m.role into v_role
    from public.memberships m
    where m.organization_id = p_organization_id
      and m.user_id = p_actor_user_id
      and m.status = 'active';
  return v_role; -- null se não tem membership ativa nessa org
end;
$fn$;

-- Papéis que podem gerenciar equipe (owner/admin/platform_admin).
create or replace function public.team_actor_is_manager(p_role text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select p_role in ('organization_owner', 'organization_admin', 'platform_admin');
$$;

-- Papéis que um ator pode CONCEDER a outra pessoa — espelha exatamente a
-- policy membership_org_admin_write (0008): owner = qualquer um exceto
-- platform_admin; admin = só papéis abaixo dele; platform_admin = qualquer um.
create or replace function public.team_role_grantable(p_actor_role text, p_new_role text)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select case p_actor_role
    when 'platform_admin' then true
    when 'organization_owner' then p_new_role <> 'platform_admin'
    when 'organization_admin' then p_new_role in ('manager','closer','receptionist','professional','financial','viewer')
    else false
  end;
$$;

-- Quem pode sequer TOCAR na membership de um alvo (independente do papel
-- novo) — hierarquia estrita: organization_admin só administra papéis
-- ESTRITAMENTE abaixo do próprio (nunca outro admin, nunca owner, nunca
-- platform_admin, nunca a SI MESMO — nem pra se auto-rebaixar/suspender/
-- remover/trocar unidade). Só organization_owner ou platform_admin
-- administram uma membership organization_admin ou organization_owner.
-- organization_owner NÃO tem essa restrição de auto-gestão (só a proteção
-- de último owner, que é checada à parte) — a regra de "nunca a si mesmo"
-- é específica de organization_admin, não geral.
create or replace function public.team_actor_can_manage_target(p_actor_role text, p_target_role text, p_is_self boolean)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when p_actor_role = 'platform_admin' then true
    when p_actor_role = 'organization_admin' and p_is_self then false
    when p_actor_role = 'organization_owner' then p_target_role <> 'platform_admin'
    when p_actor_role = 'organization_admin' then p_target_role in ('manager','closer','receptionist','professional','financial','viewer')
    else false
  end;
$$;

-- ---------------------------------------------------------------------
-- 4. Ponte legada: mantém user_doctor_access em sincronia SÓ para role
--    'closer' (único papel com equivalente no modelo antigo — ver auditoria
--    23, §4). organization_doctor_map é unique(doctor_id) -> no máximo um
--    doctor_id por organização.
-- ---------------------------------------------------------------------
create or replace function public.team_sync_legacy_bridge(p_organization_id uuid, p_user_id uuid, p_role text, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_doctor_id uuid;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;
  select doctor_id into v_doctor_id
    from public.organization_doctor_map
    where organization_id = p_organization_id;
  if v_doctor_id is null then
    return; -- organização sem doctor mapeado (ex.: criada fora do backfill) -> nada a espelhar
  end if;

  if p_role = 'closer' and p_active then
    insert into public.user_doctor_access (user_id, doctor_id)
      values (p_user_id, v_doctor_id)
      on conflict (user_id, doctor_id) do nothing;
  else
    delete from public.user_doctor_access
      where user_id = p_user_id and doctor_id = v_doctor_id;
  end if;
end;
$fn$;

-- ---------------------------------------------------------------------
-- 5. RPC: adicionar membro (a conta em `users` já existe — criada pelo
--    backend via Supabase Auth admin antes de chamar esta função).
-- ---------------------------------------------------------------------
create or replace function public.team_member_add(
  p_organization_id uuid,
  p_actor_user_id   uuid,
  p_target_user_id  uuid,
  p_role            text,
  p_unit_ids        uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor_role text;
  v_membership_id uuid;
  v_bad_unit uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_actor_user_id then raise exception 'forbidden'; end if;
  if not exists (select 1 from public.organizations o where o.id = p_organization_id) then
    raise exception 'not_found';
  end if;
  if not exists (select 1 from public.users u where u.id = p_target_user_id) then
    raise exception 'not_found';
  end if;
  if p_role not in ('organization_owner','organization_admin','manager','closer','receptionist','professional','financial','viewer') then
    raise exception 'invalid_role';
  end if;

  v_actor_role := public.team_actor_role(p_organization_id, p_actor_user_id);
  if v_actor_role is null or not public.team_actor_is_manager(v_actor_role) then
    raise exception 'forbidden';
  end if;
  if not public.team_role_grantable(v_actor_role, p_role) then
    raise exception 'forbidden';
  end if;

  if exists (select 1 from public.memberships m where m.organization_id = p_organization_id and m.user_id = p_target_user_id) then
    raise exception 'conflict';
  end if;

  -- unidades precisam pertencer à MESMA organização.
  select u.id into v_bad_unit
    from unnest(p_unit_ids) as u(id)
    where not exists (select 1 from public.units un where un.id = u.id and un.organization_id = p_organization_id);
  if v_bad_unit is not null then
    raise exception 'unit_not_in_organization';
  end if;

  insert into public.memberships (organization_id, user_id, role, status)
    values (p_organization_id, p_target_user_id, p_role, 'active')
    returning id into v_membership_id;

  if array_length(p_unit_ids, 1) > 0 then
    insert into public.membership_units (membership_id, unit_id)
      select v_membership_id, u.id from unnest(p_unit_ids) as u(id)
      on conflict do nothing;
  end if;

  perform public.team_sync_legacy_bridge(p_organization_id, p_target_user_id, p_role, true);

  insert into public.team_membership_events (organization_id, actor_user_id, target_user_id, action, result, detail)
    values (p_organization_id, p_actor_user_id, p_target_user_id, 'add', 'success', jsonb_build_object('role', p_role));

  return jsonb_build_object('membership_id', v_membership_id, 'role', p_role, 'status', 'active');
end;
$fn$;

-- ---------------------------------------------------------------------
-- 6. RPC: alterar papel. Bloqueia rebaixar/trocar o último owner ativo.
-- ---------------------------------------------------------------------
create or replace function public.team_member_change_role(
  p_organization_id uuid,
  p_actor_user_id   uuid,
  p_target_user_id  uuid,
  p_new_role        text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor_role text;
  v_target_role text;
  v_target_status text;
  v_owner_count int;
begin
  if auth.uid() is not null and auth.uid() <> p_actor_user_id then raise exception 'forbidden'; end if;
  if p_new_role not in ('organization_owner','organization_admin','manager','closer','receptionist','professional','financial','viewer') then
    raise exception 'invalid_role';
  end if;

  select m.role, m.status into v_target_role, v_target_status
    from public.memberships m
    where m.organization_id = p_organization_id and m.user_id = p_target_user_id
    for update;
  if v_target_role is null then
    raise exception 'not_found';
  end if;

  v_actor_role := public.team_actor_role(p_organization_id, p_actor_user_id);
  if v_actor_role is null or not public.team_actor_is_manager(v_actor_role) then
    raise exception 'forbidden';
  end if;
  if not public.team_role_grantable(v_actor_role, p_new_role) then
    raise exception 'forbidden';
  end if;
  -- hierarquia estrita: organization_admin só toca papéis abaixo do próprio,
  -- nunca outro admin/owner/platform_admin, nunca a si mesmo.
  if not public.team_actor_can_manage_target(v_actor_role, v_target_role, p_actor_user_id = p_target_user_id) then
    raise exception 'forbidden';
  end if;

  if v_target_role = 'organization_owner' and p_new_role <> 'organization_owner' then
    -- FOR UPDATE trava TODAS as linhas de owner ativo antes de contar --
    -- sem isso, duas transacoes concorrentes rebaixando OWNERS DIFERENTES
    -- veriam a mesma contagem (>1) sob READ COMMITTED e ambas passariam,
    -- zerando os owners. Com o lock, a segunda espera a primeira commitar
    -- e recontar contra o estado ja atualizado.
    with locked_owners as (
      select id from public.memberships
      where organization_id = p_organization_id and role = 'organization_owner' and status = 'active'
      order by id -- ordem determinística evita deadlock com locks concorrentes
      for update
    )
    select count(*) into v_owner_count from locked_owners;
    if v_owner_count <= 1 then
      raise exception 'last_owner_protected';
    end if;
  end if;

  update public.memberships set role = p_new_role, updated_at = now()
    where organization_id = p_organization_id and user_id = p_target_user_id;

  perform public.team_sync_legacy_bridge(p_organization_id, p_target_user_id, p_new_role, v_target_status = 'active');

  insert into public.team_membership_events (organization_id, actor_user_id, target_user_id, action, result, detail)
    values (p_organization_id, p_actor_user_id, p_target_user_id, 'change_role', 'success',
            jsonb_build_object('from', v_target_role, 'to', p_new_role));

  return jsonb_build_object('role', p_new_role, 'status', v_target_status);
end;
$fn$;

-- ---------------------------------------------------------------------
-- 7. RPC: suspender / reativar. Reativação é SEMPRE explícita (nunca
--    automática — o backfill nunca chama esta função).
-- ---------------------------------------------------------------------
create or replace function public.team_member_set_status(
  p_organization_id uuid,
  p_actor_user_id   uuid,
  p_target_user_id  uuid,
  p_new_status      text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor_role text;
  v_target_role text;
  v_target_status text;
  v_owner_count int;
begin
  if auth.uid() is not null and auth.uid() <> p_actor_user_id then raise exception 'forbidden'; end if;
  if p_new_status not in ('active','suspended') then
    raise exception 'invalid_status';
  end if;

  select m.role, m.status into v_target_role, v_target_status
    from public.memberships m
    where m.organization_id = p_organization_id and m.user_id = p_target_user_id
    for update;
  if v_target_role is null then
    raise exception 'not_found';
  end if;

  v_actor_role := public.team_actor_role(p_organization_id, p_actor_user_id);
  if v_actor_role is null or not public.team_actor_is_manager(v_actor_role) then
    raise exception 'forbidden';
  end if;
  -- hierarquia estrita: organization_admin só toca papéis abaixo do
  -- próprio, nunca outro admin/owner/platform_admin, nunca a si mesmo.
  if not public.team_actor_can_manage_target(v_actor_role, v_target_role, p_actor_user_id = p_target_user_id) then
    raise exception 'forbidden';
  end if;

  if v_target_role = 'organization_owner' and p_new_status = 'suspended' then
    -- FOR UPDATE trava TODAS as linhas de owner ativo antes de contar --
    -- sem isso, duas transacoes concorrentes rebaixando OWNERS DIFERENTES
    -- veriam a mesma contagem (>1) sob READ COMMITTED e ambas passariam,
    -- zerando os owners. Com o lock, a segunda espera a primeira commitar
    -- e recontar contra o estado ja atualizado.
    with locked_owners as (
      select id from public.memberships
      where organization_id = p_organization_id and role = 'organization_owner' and status = 'active'
      order by id -- ordem determinística evita deadlock com locks concorrentes
      for update
    )
    select count(*) into v_owner_count from locked_owners;
    if v_owner_count <= 1 then
      raise exception 'last_owner_protected';
    end if;
  end if;

  update public.memberships set status = p_new_status, updated_at = now()
    where organization_id = p_organization_id and user_id = p_target_user_id;

  perform public.team_sync_legacy_bridge(p_organization_id, p_target_user_id, v_target_role, p_new_status = 'active');

  insert into public.team_membership_events (organization_id, actor_user_id, target_user_id, action, result, detail)
    values (p_organization_id, p_actor_user_id, p_target_user_id,
            case when p_new_status = 'suspended' then 'suspend' else 'reactivate' end,
            'success', jsonb_build_object('from', v_target_status, 'to', p_new_status));

  return jsonb_build_object('role', v_target_role, 'status', p_new_status);
end;
$fn$;

-- ---------------------------------------------------------------------
-- 8. RPC: remover (apaga a membership; não apaga a conta em `users`).
-- ---------------------------------------------------------------------
create or replace function public.team_member_remove(
  p_organization_id uuid,
  p_actor_user_id   uuid,
  p_target_user_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor_role text;
  v_target_role text;
  v_owner_count int;
begin
  if auth.uid() is not null and auth.uid() <> p_actor_user_id then raise exception 'forbidden'; end if;
  select m.role into v_target_role
    from public.memberships m
    where m.organization_id = p_organization_id and m.user_id = p_target_user_id
    for update;
  if v_target_role is null then
    raise exception 'not_found';
  end if;

  v_actor_role := public.team_actor_role(p_organization_id, p_actor_user_id);
  if v_actor_role is null or not public.team_actor_is_manager(v_actor_role) then
    raise exception 'forbidden';
  end if;
  -- hierarquia estrita: organization_admin só toca papéis abaixo do
  -- próprio, nunca outro admin/owner/platform_admin, nunca a si mesmo.
  if not public.team_actor_can_manage_target(v_actor_role, v_target_role, p_actor_user_id = p_target_user_id) then
    raise exception 'forbidden';
  end if;

  if v_target_role = 'organization_owner' then
    -- FOR UPDATE trava TODAS as linhas de owner ativo antes de contar --
    -- sem isso, duas transacoes concorrentes rebaixando OWNERS DIFERENTES
    -- veriam a mesma contagem (>1) sob READ COMMITTED e ambas passariam,
    -- zerando os owners. Com o lock, a segunda espera a primeira commitar
    -- e recontar contra o estado ja atualizado.
    with locked_owners as (
      select id from public.memberships
      where organization_id = p_organization_id and role = 'organization_owner' and status = 'active'
      order by id -- ordem determinística evita deadlock com locks concorrentes
      for update
    )
    select count(*) into v_owner_count from locked_owners;
    if v_owner_count <= 1 then
      raise exception 'last_owner_protected';
    end if;
  end if;

  delete from public.memberships
    where organization_id = p_organization_id and user_id = p_target_user_id;
  -- membership_units cai em cascata (FK on delete cascade, 0008).

  perform public.team_sync_legacy_bridge(p_organization_id, p_target_user_id, v_target_role, false);

  insert into public.team_membership_events (organization_id, actor_user_id, target_user_id, action, result, detail)
    values (p_organization_id, p_actor_user_id, p_target_user_id, 'remove', 'success', jsonb_build_object('role', v_target_role));

  return jsonb_build_object('removed', true);
end;
$fn$;

-- ---------------------------------------------------------------------
-- 9. RPC: (re)definir as unidades de uma membership (substitui o conjunto).
-- ---------------------------------------------------------------------
create or replace function public.team_member_set_units(
  p_organization_id uuid,
  p_actor_user_id   uuid,
  p_target_user_id  uuid,
  p_unit_ids        uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor_role text;
  v_target_role text;
  v_membership_id uuid;
  v_bad_unit uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_actor_user_id then raise exception 'forbidden'; end if;
  select m.id, m.role into v_membership_id, v_target_role
    from public.memberships m
    where m.organization_id = p_organization_id and m.user_id = p_target_user_id
    for update;
  if v_membership_id is null then
    raise exception 'not_found';
  end if;

  v_actor_role := public.team_actor_role(p_organization_id, p_actor_user_id);
  if v_actor_role is null or not public.team_actor_is_manager(v_actor_role) then
    raise exception 'forbidden';
  end if;
  -- hierarquia estrita: organization_admin só toca papéis abaixo do próprio,
  -- nunca outro admin/owner/platform_admin, nunca a si mesmo.
  if not public.team_actor_can_manage_target(v_actor_role, v_target_role, p_actor_user_id = p_target_user_id) then
    raise exception 'forbidden';
  end if;

  select u.id into v_bad_unit
    from unnest(p_unit_ids) as u(id)
    where not exists (select 1 from public.units un where un.id = u.id and un.organization_id = p_organization_id);
  if v_bad_unit is not null then
    raise exception 'unit_not_in_organization';
  end if;

  delete from public.membership_units where membership_id = v_membership_id;
  if array_length(p_unit_ids, 1) > 0 then
    insert into public.membership_units (membership_id, unit_id)
      select v_membership_id, u.id from unnest(p_unit_ids) as u(id)
      on conflict do nothing;
  end if;

  insert into public.team_membership_events (organization_id, actor_user_id, target_user_id, action, result, detail)
    values (p_organization_id, p_actor_user_id, p_target_user_id, 'set_units', 'success',
            jsonb_build_object('unit_count', coalesce(array_length(p_unit_ids, 1), 0)));

  return jsonb_build_object('unit_ids', p_unit_ids);
end;
$fn$;

-- ---------------------------------------------------------------------
-- 10. Grants mínimos: só service_role chama as RPCs de mutação/leitura de
--     ator. anon/authenticated ficam de fora (o browser nunca chama isso
--     direto; toda escrita passa pelo backend). Revoke em bloco único, no
--     final do arquivo — depois de TODAS as funções já criadas (o Postgres
--     concede EXECUTE a PUBLIC automaticamente em cada CREATE FUNCTION, via
--     ALTER DEFAULT PRIVILEGES da migration 0000; revogar aqui, de uma vez,
--     evita qualquer statement intercalado que não tenha colado no reset).
-- ---------------------------------------------------------------------
revoke execute on function public.team_actor_role(uuid, uuid) from public;
revoke execute on function public.team_actor_role(uuid, uuid) from anon, authenticated;
revoke execute on function public.team_actor_is_manager(text) from public;
revoke execute on function public.team_actor_is_manager(text) from anon, authenticated;
revoke execute on function public.team_role_grantable(text, text) from public;
revoke execute on function public.team_role_grantable(text, text) from anon, authenticated;
revoke execute on function public.team_actor_can_manage_target(text, text, boolean) from public;
revoke execute on function public.team_actor_can_manage_target(text, text, boolean) from anon, authenticated;
revoke execute on function public.team_sync_legacy_bridge(uuid, uuid, text, boolean) from public;
revoke execute on function public.team_sync_legacy_bridge(uuid, uuid, text, boolean) from anon, authenticated;
revoke execute on function public.team_member_add(uuid, uuid, uuid, text, uuid[]) from public;
revoke execute on function public.team_member_add(uuid, uuid, uuid, text, uuid[]) from anon, authenticated;
revoke execute on function public.team_member_change_role(uuid, uuid, uuid, text) from public;
revoke execute on function public.team_member_change_role(uuid, uuid, uuid, text) from anon, authenticated;
revoke execute on function public.team_member_set_status(uuid, uuid, uuid, text) from public;
revoke execute on function public.team_member_set_status(uuid, uuid, uuid, text) from anon, authenticated;
revoke execute on function public.team_member_remove(uuid, uuid, uuid) from public;
revoke execute on function public.team_member_remove(uuid, uuid, uuid) from anon, authenticated;
revoke execute on function public.team_member_set_units(uuid, uuid, uuid, uuid[]) from public;
revoke execute on function public.team_member_set_units(uuid, uuid, uuid, uuid[]) from anon, authenticated;
-- team_backfill_reconcile só é criada na seção 11, abaixo — seu revoke fica
-- junto do respectivo grant, depois da função existir.

grant execute on function public.team_actor_role(uuid, uuid) to service_role;
grant execute on function public.team_actor_is_manager(text) to service_role;
grant execute on function public.team_role_grantable(text, text) to service_role;
grant execute on function public.team_actor_can_manage_target(text, text, boolean) to service_role;
grant execute on function public.team_sync_legacy_bridge(uuid, uuid, text, boolean) to service_role;
grant execute on function public.team_member_add(uuid, uuid, uuid, text, uuid[]) to service_role;
grant execute on function public.team_member_change_role(uuid, uuid, uuid, text) to service_role;
grant execute on function public.team_member_set_status(uuid, uuid, uuid, text) to service_role;
grant execute on function public.team_member_remove(uuid, uuid, uuid) to service_role;
grant execute on function public.team_member_set_units(uuid, uuid, uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------
-- 11. Backfill de reconciliação (ETAPA 6) — roda a comparação já usada por
--     teamShadowRead, mas para TODA organização mapeada, e grava só
--     contagens (nunca IDs de usuário/telefone/e-mail) em
--     team_backfill_reconciliation. Idempotente: cada execução insere uma
--     nova leitura (série histórica) — não é upsert por design, é um log
--     de reconciliação; reexecutar não corrige nada, só re-observa.
-- ---------------------------------------------------------------------
create or replace function public.team_backfill_reconcile()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  m record;
  v_legacy_ids uuid[];
  v_member_ids uuid[];
  v_only_legacy int;
  v_only_membership int;
  v_suspended int;
  v_owner uuid;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;
  for m in select organization_id, doctor_id from public.organization_doctor_map loop
    select owner_user_id into v_owner from public.doctors where id = m.doctor_id;

    select coalesce(array_agg(distinct uda.user_id), '{}') into v_legacy_ids
      from public.user_doctor_access uda where uda.doctor_id = m.doctor_id;
    if v_owner is not null then
      v_legacy_ids := array_append(v_legacy_ids, v_owner);
    end if;

    select coalesce(array_agg(mem.user_id), '{}') into v_member_ids
      from public.memberships mem where mem.organization_id = m.organization_id and mem.status = 'active';

    select count(*) into v_only_legacy
      from unnest(v_legacy_ids) id where id <> all(v_member_ids);
    select count(*) into v_only_membership
      from unnest(v_member_ids) id where id <> all(v_legacy_ids);
    select count(*) into v_suspended
      from public.memberships mem
      where mem.organization_id = m.organization_id and mem.status = 'suspended'
        and mem.user_id = any(v_legacy_ids);

    insert into public.team_backfill_reconciliation
      (organization_id, only_legacy_count, only_membership_count, suspended_divergence, classification)
    values (
      m.organization_id, v_only_legacy, v_only_membership, v_suspended,
      case when v_only_legacy = 0 and v_only_membership = 0 and v_suspended = 0 then 'match' else 'divergent' end
    );
  end loop;
end;
$fn$;
revoke execute on function public.team_backfill_reconcile() from public;
revoke execute on function public.team_backfill_reconcile() from anon, authenticated;
grant execute on function public.team_backfill_reconcile() to service_role;
