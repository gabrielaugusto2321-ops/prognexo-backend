-- Reatribuicao atomica do closer entre lead e todos os seus deals.
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.

create or replace function public.reassign_lead_closer(p_lead_id uuid, p_new_sdr_id uuid, p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_lead public.leads%rowtype;
  v_doctor public.doctors%rowtype;
  v_organization_id uuid;
  v_actor_allowed boolean := false;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;

  select l.* into v_lead from public.leads l where l.id = p_lead_id for update;
  if not found then raise exception 'lead_not_found'; end if;

  select d.* into v_doctor from public.doctors d where d.id = v_lead.doctor_id;
  v_organization_id := v_lead.organization_id;
  if v_organization_id is null then
    select odm.organization_id into v_organization_id
      from public.organization_doctor_map odm where odm.doctor_id = v_lead.doctor_id;
  end if;

  v_actor_allowed := exists (
    select 1 from public.users u where u.id = p_actor_user_id
      and (u.role = 'admin' or (u.role = 'doctor' and v_doctor.owner_user_id = u.id))
  );
  if not v_actor_allowed and v_organization_id is not null then
    v_actor_allowed := exists (
      select 1 from public.platform_admins pa where pa.user_id = p_actor_user_id
    ) or exists (
      select 1 from public.memberships m where m.organization_id = v_organization_id
        and m.user_id = p_actor_user_id and m.status = 'active'
        and m.role in ('organization_owner', 'organization_admin', 'platform_admin')
    );
  end if;
  if not v_actor_allowed then raise exception 'forbidden'; end if;

  if p_new_sdr_id is not null and not exists (
    select 1 from public.users u where u.id = p_new_sdr_id and u.ativo = true
      and (
        (u.role = 'closer' and exists (
          select 1 from public.user_doctor_access uda
          where uda.user_id = u.id and uda.doctor_id = v_lead.doctor_id
        ))
        or (v_organization_id is not null and exists (
          select 1 from public.memberships m where m.organization_id = v_organization_id
            and m.user_id = u.id and m.role = 'closer' and m.status = 'active'
        ))
      )
  ) then
    raise exception 'invalid_closer';
  end if;

  update public.leads set sdr_responsavel_id = p_new_sdr_id where id = p_lead_id returning * into v_lead;
  update public.deals set sdr_responsavel_id = p_new_sdr_id where lead_id = p_lead_id;
  return to_jsonb(v_lead);
end;
$fn$;

do $grants$
begin
  revoke all on function public.reassign_lead_closer(uuid, uuid, uuid) from public;
  revoke all on function public.reassign_lead_closer(uuid, uuid, uuid) from anon, authenticated;
  grant execute on function public.reassign_lead_closer(uuid, uuid, uuid) to service_role;
end;
$grants$;
