-- Expiracao de cortesia calculada em tempo de requisicao pelo backend.
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.

alter table public.doctors
  add column if not exists courtesy_expires_at timestamptz;

comment on column public.doctors.courtesy_expires_at is
  'Fim da cortesia. NULL significa acesso sem expiracao; nao altera status automaticamente.';

-- Consolida em UMA query a decisao "este request deve ser bloqueado por
-- cortesia vencida ou conta pausada" -- chamada uma vez por requireAuth em
-- vez de ate 5 queries separadas (doctors/user_doctor_access/memberships/
-- organization_doctor_map/doctors de novo).
--
-- Ambiguidade nunca bloqueia aqui (fica pra autorizacao por rota, que ja
-- exige doctor_id/organizacao explicita):
--   - com p_organization_id: usa SO o doctor daquela organizacao (permite
--     "/tenant/context" listar organizacoes e trocar pra uma valida mesmo
--     que outra esteja vencida -- o caller so passa organizacao quando o
--     usuario ja selecionou uma, nunca antes disso).
--   - sem p_organization_id: usa o doctor OWNED (papel legado 'doctor') se
--     houver exatamente um; senao, o doctor de acesso legado (closer via
--     user_doctor_access) SE for exatamente um; qualquer outra combinacao
--     (zero ou multiplos candidatos, ou so vinculo via membership sem
--     organizacao selecionada) NAO bloqueia aqui -- nunca pune o usuario
--     inteiro por uma organizacao entre varias estar vencida.
create or replace function public.doctor_access_gate(p_user_id uuid, p_organization_id uuid default null)
returns table (blocked boolean, reason text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_is_admin boolean;
  v_doctor_id uuid;
  v_count int;
  v_status text;
  v_courtesy timestamptz;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;

  select exists(select 1 from public.users u where u.id = p_user_id and u.role = 'admin')
      or exists(select 1 from public.platform_admins pa where pa.user_id = p_user_id)
    into v_is_admin;
  if v_is_admin then
    return query select false, null::text;
    return;
  end if;

  if p_organization_id is not null then
    select odm.doctor_id into v_doctor_id
      from public.organization_doctor_map odm
      where odm.organization_id = p_organization_id
      limit 1;
  else
    -- min()/max() nao tem agregado definido pra uuid neste Postgres (erro
    -- "function min(uuid) does not exist", confirmado rodando de verdade —
    -- o mock JS nunca pegaria isso). count(*) + um id qualquer via subquery
    -- resolve sem precisar de agregado sobre uuid.
    select count(*) into v_count from public.doctors where owner_user_id = p_user_id;
    if v_count = 1 then
      select id into v_doctor_id from public.doctors where owner_user_id = p_user_id limit 1;
    else
      select count(*) into v_count from public.user_doctor_access where user_id = p_user_id;
      if v_count = 1 then
        select doctor_id into v_doctor_id from public.user_doctor_access where user_id = p_user_id limit 1;
      else
        v_doctor_id := null;
      end if;
    end if;
  end if;

  if v_doctor_id is null then
    return query select false, null::text;
    return;
  end if;

  select d.status, d.courtesy_expires_at into v_status, v_courtesy
    from public.doctors d where d.id = v_doctor_id;

  if v_status = 'pausado' then
    return query select true, 'account_paused'::text;
    return;
  end if;

  if v_courtesy is not null and v_courtesy < now() then
    return query select true, 'courtesy_expired'::text;
    return;
  end if;

  return query select false, null::text;
end;
$fn$;

do $grants$ declare r record; begin
 for r in select p.oid::regprocedure sig from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('doctor_access_gate') loop
   execute format('revoke execute on function %s from public',r.sig); execute format('revoke execute on function %s from anon, authenticated',r.sig); execute format('grant execute on function %s to service_role',r.sig);
 end loop;
end;$grants$;
