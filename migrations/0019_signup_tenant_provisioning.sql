-- Provisionamento transacional do tenant no cadastro publico.
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.

create or replace function public.signup_provision_tenant(
  p_auth_user_id uuid,
  p_nome text,
  p_email text,
  p_clinica_nome text
)
returns table (doctor_id uuid, organization_id uuid, unit_id uuid, membership_id uuid)
language plpgsql
security definer
set search_path = ''
as $fn$
-- `returns table(doctor_id, organization_id, unit_id, membership_id)` cria
-- variáveis OUT com ESSES MESMOS NOMES no escopo da função. Os dois ON
-- CONFLICT abaixo (organization_doctor_map.doctor_id;
-- membership_units.membership_id/unit_id) referenciam coluna por nome puro
-- (a lista-alvo do ON CONFLICT não aceita "tabela.coluna") e colidiam com
-- essas variáveis OUT — "column reference is ambiguous", confirmado rodando
-- a função de verdade num Postgres real. Todo o resto do corpo já usa alias
-- de tabela ou as locals v_*, então forçar a coluna vencer aqui é seguro.
#variable_conflict use_column
declare
  v_doctor_id uuid;
  v_organization_id uuid;
  v_unit_id uuid;
  v_membership_id uuid;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;

  -- Idempotência POR ETAPA — nunca "tudo ou nada por atalho": uma chamada
  -- repetida (ou uma retomada após falha parcial de uma versão anterior desta
  -- função) precisa completar exatamente o que falta, sem duplicar nada e sem
  -- pular etapas só porque as duas primeiras já existem.
  insert into public.users (id, nome, email, role, ativo, status)
    values (p_auth_user_id, p_nome, p_email, 'doctor', false, 'pending')
    on conflict (id) do nothing;

  -- status 'prospect': doctors_status_check em producao so aceita
  -- ativo/prospect/pausado/encerrado (confirmado contra o schema real —
  -- 'pendente' nao existe nessa constraint e faria este insert falhar).
  -- Vira 'ativo' em POST /activation/complete quando o owner confirma o
  -- e-mail; ate la o gate de acesso e users.status='pending' (nao este campo).
  select d.id into v_doctor_id from public.doctors d where d.owner_user_id = p_auth_user_id limit 1;
  if v_doctor_id is null then
    insert into public.doctors (owner_user_id, nome, status, plano)
      values (p_auth_user_id, coalesce(nullif(trim(p_clinica_nome), ''), p_nome), 'prospect', 'gratuito')
      returning id into v_doctor_id;
  end if;

  select odm.organization_id, odm.default_unit_id into v_organization_id, v_unit_id
    from public.organization_doctor_map odm where odm.doctor_id = v_doctor_id;

  if v_organization_id is null then
    insert into public.organizations (name, slug, status)
      values (coalesce(nullif(trim(p_clinica_nome), ''), 'Organizacao ' || substr(v_doctor_id::text, 1, 8)),
              'org-' || replace(v_doctor_id::text, '-', ''), 'active')
      returning id into v_organization_id;
  end if;

  if v_unit_id is null then
    select u.id into v_unit_id from public.units u where u.organization_id = v_organization_id limit 1;
  end if;
  if v_unit_id is null then
    insert into public.units (organization_id, name, status, timezone)
      values (v_organization_id, 'Unidade principal', 'active', 'America/Sao_Paulo')
      returning id into v_unit_id;
  end if;

  insert into public.organization_doctor_map (organization_id, doctor_id, default_unit_id)
    values (v_organization_id, v_doctor_id, v_unit_id)
    on conflict (doctor_id) do update
      set default_unit_id = coalesce(public.organization_doctor_map.default_unit_id, excluded.default_unit_id);

  select m.id into v_membership_id from public.memberships m
    where m.organization_id = v_organization_id and m.user_id = p_auth_user_id;
  if v_membership_id is null then
    insert into public.memberships (organization_id, user_id, role, status)
      values (v_organization_id, p_auth_user_id, 'organization_owner', 'active')
      returning id into v_membership_id;
  end if;

  insert into public.membership_units (membership_id, unit_id)
    values (v_membership_id, v_unit_id)
    on conflict (membership_id, unit_id) do nothing;

  return query select v_doctor_id, v_organization_id, v_unit_id, v_membership_id;
end;
$fn$;

do $grants$ declare r record; begin
 for r in select p.oid::regprocedure sig from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('signup_provision_tenant') loop
   execute format('revoke execute on function %s from public',r.sig); execute format('revoke execute on function %s from anon, authenticated',r.sig); execute format('grant execute on function %s to service_role',r.sig);
 end loop;
end;$grants$;
