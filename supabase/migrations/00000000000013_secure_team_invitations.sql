-- FASE 2.7 — convites seguros e outbox Postgres-only (aditiva).
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.

create table if not exists public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and length(email) > 0),
  intended_role text not null check (intended_role in ('organization_owner','organization_admin','manager','closer','receptionist','professional','financial','viewer')),
  invited_by_user_id uuid not null references public.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','provisioning','ready','queued','sent','accepted','expired','cancelled','failed','dead_letter')),
  auth_user_id uuid,
  membership_id uuid references public.memberships(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '72 hours'),
  attempt_count int not null default 0 check (attempt_count >= 0),
  last_error_code text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  cancelled_at timestamptz
);
create unique index if not exists organization_invitations_active_email_uidx
  on public.organization_invitations (organization_id, email)
  where status in ('pending','provisioning','ready','queued','sent');
create index if not exists organization_invitations_idempotency_idx
  on public.organization_invitations (idempotency_key);

create table if not exists public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  aggregate_type text not null,
  aggregate_id uuid not null references public.organization_invitations(id) on delete cascade,
  event_type text not null,
  payload text not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','retry','dead_letter','cancelled')),
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text,
  attempt_count int not null default 0 check (attempt_count >= 0),
  max_attempts int not null default 5 check (max_attempts > 0),
  idempotency_key text not null unique,
  last_error_code text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists outbox_events_claim_idx on public.outbox_events (status, available_at)
  where status in ('pending','retry');

alter table public.organization_invitations enable row level security;
alter table public.outbox_events enable row level security;
revoke all on public.organization_invitations, public.outbox_events from public, anon, authenticated;

create or replace function public.team_invitation_create(p_organization_id uuid, p_actor_user_id uuid, p_email text, p_role text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_actor_role text; v_email text; v_existing public.organization_invitations%rowtype; v_row public.organization_invitations%rowtype;
begin
  if auth.uid() is not null and auth.uid() <> p_actor_user_id then raise exception 'forbidden'; end if;
  v_email := lower(btrim(coalesce(p_email,'')));
  if v_email = '' or position('@' in v_email) < 2 then raise exception 'invalid_email'; end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')), '') is null then raise exception 'invalid_idempotency_key'; end if;
  if p_role not in ('organization_owner','organization_admin','manager','closer','receptionist','professional','financial','viewer') then raise exception 'invalid_role'; end if;
  if not exists(select 1 from public.organizations where id=p_organization_id) then raise exception 'not_found'; end if;
  v_actor_role := public.team_actor_role(p_organization_id,p_actor_user_id);
  if v_actor_role is null or not public.team_actor_is_manager(v_actor_role) or not public.team_role_grantable(v_actor_role,p_role) then raise exception 'forbidden'; end if;
  select i.* into v_existing from public.organization_invitations i where i.organization_id=p_organization_id and i.email=v_email and i.status in ('pending','provisioning','ready','queued','sent') for update;
  if found then return to_jsonb(v_existing); end if;
  if exists(select 1 from public.memberships m join public.users u on u.id=m.user_id where m.organization_id=p_organization_id and lower(btrim(u.email))=v_email and m.status in ('active','invited')) then raise exception 'conflict'; end if;
  insert into public.organization_invitations(organization_id,email,intended_role,invited_by_user_id,idempotency_key)
    values(p_organization_id,v_email,p_role,p_actor_user_id,p_idempotency_key) returning * into v_row;
  return to_jsonb(v_row);
exception when unique_violation then
  select i.* into v_existing from public.organization_invitations i where i.organization_id=p_organization_id and i.email=v_email and i.status in ('pending','provisioning','ready','queued','sent');
  if found then return to_jsonb(v_existing); end if; raise;
end;$fn$;

create or replace function public.team_invitation_mark_provisioning(p_invitation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v public.organization_invitations%rowtype;
begin
 if auth.uid() is not null then raise exception 'forbidden'; end if;
 update public.organization_invitations set status='provisioning',attempt_count=attempt_count+1,updated_at=now(),last_error_code=null where id=p_invitation_id and status in ('pending','failed') returning * into v;
 if not found then raise exception 'invalid_state'; end if; return to_jsonb(v);
end;$fn$;

create or replace function public.team_invitation_mark_failed(p_invitation_id uuid,p_error_code text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare v public.organization_invitations%rowtype;
begin if auth.uid() is not null then raise exception 'forbidden'; end if;
 if p_error_code !~ '^[a-z0-9_]{1,64}$' then raise exception 'invalid_error_code'; end if;
 update public.organization_invitations set status='failed',last_error_code=p_error_code,updated_at=now() where id=p_invitation_id and status in ('pending','provisioning','ready') returning * into v;
 if not found then raise exception 'invalid_state'; end if; return to_jsonb(v);
end;$fn$;

create or replace function public.team_invitation_prepare_resend(p_organization_id uuid,p_actor_user_id uuid,p_invitation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare i public.organization_invitations%rowtype; ar text;
begin if auth.uid() is not null and auth.uid()<>p_actor_user_id then raise exception 'forbidden'; end if;
 select * into i from public.organization_invitations where id=p_invitation_id and organization_id=p_organization_id for update; if not found then raise exception 'not_found'; end if;
 ar:=public.team_actor_role(p_organization_id,p_actor_user_id);
 if ar is null or not public.team_actor_can_manage_target(ar,i.intended_role,false) then raise exception 'forbidden'; end if;
 if i.status not in ('queued','sent','failed') then raise exception 'invalid_state'; end if;
 update public.outbox_events set status='cancelled',processed_at=now() where aggregate_id=i.id and status in ('pending','retry');
 update public.organization_invitations set status='ready',expires_at=now()+interval '72 hours',last_error_code=null,updated_at=now() where id=i.id returning * into i;
 return to_jsonb(i);
end;$fn$;

create or replace function public.team_invitation_attach_auth_user(p_invitation_id uuid,p_auth_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare i public.organization_invitations%rowtype; mid uuid;
begin
 if auth.uid() is not null then raise exception 'forbidden'; end if;
 select * into i from public.organization_invitations where id=p_invitation_id for update;
 if not found then raise exception 'not_found'; end if;
 if i.status not in ('provisioning','ready') then raise exception 'invalid_state'; end if;
 insert into public.users(id,nome,email,role,ativo,status) values(p_auth_user_id,split_part(i.email,'@',1),i.email,'closer',true,'active')
   on conflict(id) do update set email=excluded.email;
 insert into public.memberships(organization_id,user_id,role,status) values(i.organization_id,p_auth_user_id,i.intended_role,'invited')
   on conflict(organization_id,user_id) do nothing returning id into mid;
 if mid is null then select id into mid from public.memberships where organization_id=i.organization_id and user_id=p_auth_user_id and status='invited'; end if;
 if mid is null then raise exception 'conflict'; end if;
 update public.organization_invitations set auth_user_id=p_auth_user_id,membership_id=mid,status='ready',updated_at=now() where id=p_invitation_id;
 return jsonb_build_object('invitation_id',p_invitation_id,'membership_id',mid,'status','ready');
end;$fn$;

create or replace function public.team_invitation_enqueue_outbox(p_invitation_id uuid,p_event_type text,p_payload_encrypted text,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare i public.organization_invitations%rowtype; e public.outbox_events%rowtype;
begin
 if auth.uid() is not null then raise exception 'forbidden'; end if;
 select * into i from public.organization_invitations where id=p_invitation_id for update;
 if not found then raise exception 'not_found'; end if;
 if i.status <> 'ready' then raise exception 'invalid_state'; end if;
 insert into public.outbox_events(organization_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
 values(i.organization_id,'team_invitation',i.id,p_event_type,p_payload_encrypted,p_idempotency_key)
 on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key returning * into e;
 update public.organization_invitations set status='queued',updated_at=now() where id=i.id;
 return to_jsonb(e);
end;$fn$;

-- RPC composta: profile + membership invited + outbox nascem juntos. O ID do
-- evento vem do Node para permitir cifrar com AAD ligada ao próprio recordId.
create or replace function public.team_invitation_attach_and_enqueue(p_invitation_id uuid,p_auth_user_id uuid,p_event_id uuid,p_event_type text,p_payload_encrypted text,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare i public.organization_invitations%rowtype; mid uuid; e public.outbox_events%rowtype;
begin
 if auth.uid() is not null then raise exception 'forbidden'; end if;
 select * into i from public.organization_invitations where id=p_invitation_id for update;
 if not found then raise exception 'not_found'; end if;
 if i.status not in ('provisioning','ready') then raise exception 'invalid_state'; end if;
 insert into public.users(id,nome,email,role,ativo,status) values(p_auth_user_id,split_part(i.email,'@',1),i.email,'closer',true,'active') on conflict(id) do update set email=excluded.email;
 insert into public.memberships(organization_id,user_id,role,status) values(i.organization_id,p_auth_user_id,i.intended_role,'invited') on conflict(organization_id,user_id) do nothing returning id into mid;
 if mid is null then select id into mid from public.memberships where organization_id=i.organization_id and user_id=p_auth_user_id and status='invited'; end if;
 if mid is null then raise exception 'conflict'; end if;
 insert into public.outbox_events(id,organization_id,aggregate_type,aggregate_id,event_type,payload,idempotency_key)
 values(p_event_id,i.organization_id,'team_invitation',i.id,p_event_type,p_payload_encrypted,p_idempotency_key) returning * into e;
 update public.organization_invitations set auth_user_id=p_auth_user_id,membership_id=mid,status='queued',updated_at=now() where id=i.id;
 return jsonb_build_object('invitation_id',i.id,'membership_id',mid,'event_id',e.id,'status','queued');
end;$fn$;

create or replace function public.team_outbox_claim(p_worker_id text,p_batch_size int,p_lease_seconds int)
returns setof public.outbox_events language plpgsql security definer set search_path='' as $fn$
begin
 if auth.uid() is not null then raise exception 'forbidden'; end if;
 if nullif(btrim(coalesce(p_worker_id,'')),'') is null or p_batch_size < 1 or p_batch_size > 100 or p_lease_seconds < 1 then raise exception 'invalid_argument'; end if;
 return query with candidates as (
   select id from public.outbox_events where ((status in ('pending','retry') and available_at<=now()) or (status='processing' and claimed_at < now()-make_interval(secs=>p_lease_seconds))) order by available_at,id for update skip locked limit p_batch_size
 ) update public.outbox_events e set status='processing',claimed_at=now(),claimed_by=p_worker_id,attempt_count=e.attempt_count+1 from candidates c where e.id=c.id returning e.*;
end;$fn$;

create or replace function public.team_outbox_mark_sent(p_event_id uuid,p_worker_id text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare e public.outbox_events%rowtype;
begin if auth.uid() is not null then raise exception 'forbidden'; end if;
 update public.outbox_events set status='sent',processed_at=now() where id=p_event_id and status='processing' and claimed_by=p_worker_id returning * into e;
 if not found then raise exception 'claim_mismatch'; end if;
 update public.organization_invitations set status='sent',updated_at=now() where id=e.aggregate_id and status='queued'; return to_jsonb(e);
end;$fn$;

create or replace function public.team_outbox_mark_retry(p_event_id uuid,p_worker_id text,p_error_code text,p_available_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare e public.outbox_events%rowtype; terminal boolean;
begin if auth.uid() is not null then raise exception 'forbidden'; end if;
 if p_error_code !~ '^[a-z0-9_]{1,64}$' then raise exception 'invalid_error_code'; end if;
 select * into e from public.outbox_events where id=p_event_id and status='processing' and claimed_by=p_worker_id for update;
 if not found then raise exception 'claim_mismatch'; end if; terminal:=e.attempt_count>=e.max_attempts;
 update public.outbox_events set status=case when terminal then 'dead_letter' else 'pending' end,available_at=p_available_at,claimed_at=null,claimed_by=null,last_error_code=p_error_code,processed_at=case when terminal then now() else null end where id=e.id returning * into e;
 if terminal then update public.organization_invitations set status='failed',last_error_code=p_error_code,updated_at=now() where id=e.aggregate_id; end if; return to_jsonb(e);
end;$fn$;

create or replace function public.team_invitation_cancel(p_organization_id uuid,p_actor_user_id uuid,p_invitation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare i public.organization_invitations%rowtype; ar text;
begin if auth.uid() is not null and auth.uid()<>p_actor_user_id then raise exception 'forbidden'; end if;
 select * into i from public.organization_invitations where id=p_invitation_id and organization_id=p_organization_id for update; if not found then raise exception 'not_found'; end if;
 ar:=public.team_actor_role(p_organization_id,p_actor_user_id);
 if ar is null or not public.team_actor_can_manage_target(ar,i.intended_role,false) then raise exception 'forbidden'; end if;
 if i.status not in ('pending','provisioning','ready','queued','sent') then raise exception 'invalid_state'; end if;
 update public.organization_invitations set status='cancelled',cancelled_at=now(),updated_at=now() where id=i.id;
 update public.outbox_events set status='cancelled',processed_at=now() where aggregate_id=i.id and status in ('pending','retry');
 return jsonb_build_object('id',i.id,'status','cancelled');
end;$fn$;

create or replace function public.team_invitation_accept(p_auth_user_id uuid,p_invitation_id uuid,p_token_marker text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare i public.organization_invitations%rowtype;
begin
 -- p_auth_user_id vem exclusivamente de supabase.auth.getUser(Bearer) no Node.
 if auth.uid() is not null and auth.uid()<>p_auth_user_id then raise exception 'forbidden'; end if;
 if nullif(btrim(coalesce(p_token_marker,'')),'') is null then raise exception 'invalid_token_marker'; end if;
 select * into i from public.organization_invitations where id=p_invitation_id for update; if not found then raise exception 'not_found'; end if;
 if i.status='accepted' then if i.auth_user_id=p_auth_user_id then return jsonb_build_object('id',i.id,'status','accepted'); else raise exception 'forbidden'; end if; end if;
 if i.status='cancelled' then raise exception 'cancelled'; end if;
 -- Nota: NÃO dá pra fazer "update status='expired' ... ; raise exception" aqui
 -- e esperar que o update persista — uma exceção não capturada desfaz TUDO
 -- que a função escreveu nesta chamada (não há savepoint implícito nesse
 -- ponto). A marcação em massa de expirados é feita à parte, por
 -- team_invitation_sweep_expired() (chamada pelo worker) — aqui só bloqueia
 -- o aceite, que é a garantia de segurança que importa.
 if i.expires_at<=now() then raise exception 'expired'; end if;
 if i.auth_user_id is distinct from p_auth_user_id or i.status not in ('queued','sent') then raise exception 'forbidden'; end if;
 update public.memberships set status='active',updated_at=now() where id=i.membership_id and user_id=p_auth_user_id and status='invited'; if not found then raise exception 'invalid_state'; end if;
 perform public.team_sync_legacy_bridge(i.organization_id,p_auth_user_id,i.intended_role,true);
 update public.organization_invitations set status='accepted',accepted_at=now(),updated_at=now() where id=i.id;
 return jsonb_build_object('id',i.id,'status','accepted','membership_id',i.membership_id);
end;$fn$;

-- Varredura de expiração — backend-only, chamada pelo worker (não pelo
-- accept, que só pode BLOQUEAR o aceite, nunca persistir a marcação — ver
-- comentário em team_invitation_accept). Idempotente, sem PII no retorno.
create or replace function public.team_invitation_sweep_expired()
returns int language plpgsql security definer set search_path='' as $fn$
declare v_count int;
begin
 if auth.uid() is not null then raise exception 'forbidden'; end if;
 with expired as (
   update public.organization_invitations set status='expired',updated_at=now()
   where status in ('queued','sent') and expires_at<=now()
   returning id
 )
 select count(*) into v_count from expired;
 return v_count;
end;$fn$;

do $grants$ declare r record; begin
 for r in select p.oid::regprocedure sig from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('team_invitation_create','team_invitation_mark_provisioning','team_invitation_mark_failed','team_invitation_prepare_resend','team_invitation_attach_auth_user','team_invitation_enqueue_outbox','team_invitation_attach_and_enqueue','team_outbox_claim','team_outbox_mark_sent','team_outbox_mark_retry','team_invitation_cancel','team_invitation_accept','team_invitation_sweep_expired') loop
   execute format('revoke execute on function %s from public',r.sig); execute format('revoke execute on function %s from anon, authenticated',r.sig); execute format('grant execute on function %s to service_role',r.sig);
 end loop;
end;$grants$;
