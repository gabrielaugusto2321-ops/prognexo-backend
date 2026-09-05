-- FASE 2.8 - fila persistente e quotas de custo (aditiva, Postgres-only).
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.

create table if not exists public.job_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  job_type text not null check (job_type ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  -- Teto de 64KB: um payload de job é sempre pequeno (ids + metadados).
  -- Sem isso, um caller poderia enfileirar um blob multi-MB (poison job por
  -- tamanho — enche a tabela, atrasa o claim, estoura memória do worker).
  payload text not null check (length(payload) <= 65536),
  status text not null default 'pending' check (status in ('pending','processing','completed','retry','dead_letter','cancelled')),
  priority int not null default 0,
  available_at timestamptz not null default now(),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 5 check (max_attempts > 0),
  lease_owner text,
  lease_expires_at timestamptz,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
-- Dois indices parciais expressam os dois escopos: tenant inclui a organizacao;
-- global (organization_id IS NULL) deduplica apenas por tipo+chave.
create unique index if not exists job_queue_tenant_idempotency_uidx on public.job_queue(organization_id,job_type,idempotency_key) where organization_id is not null;
create unique index if not exists job_queue_global_idempotency_uidx on public.job_queue(job_type,idempotency_key) where organization_id is null;
create index if not exists job_queue_claim_idx on public.job_queue(status,available_at,priority desc) where status in ('pending','retry');
create index if not exists job_queue_orphan_lease_idx on public.job_queue(lease_expires_at) where status='processing';

-- Allowlist fixa: adicionar um tipo global exige uma nova migration/revisao.
alter table public.job_queue add constraint job_queue_global_type_check check (organization_id is not null or job_type in ('system.maintenance'));

create table if not exists public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  category text not null check (category in ('ai_tokens','ai_requests','whatsapp_messages','emails','embeddings','storage')),
  quantity numeric not null check (quantity >= 0),
  estimated_cost numeric check (estimated_cost is null or estimated_cost >= 0),
  currency text not null default 'BRL', source_type text, source_id uuid,
  idempotency_key text not null unique,
  occurred_at timestamptz not null default now(), metadata jsonb not null default '{}'::jsonb
);
comment on column public.usage_ledger.metadata is 'Metadados tecnicos sem prompt, mensagem, token, segredo ou dado pessoal.';

create table if not exists public.usage_limits (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  category text not null check (category in ('ai_tokens','ai_requests','whatsapp_messages','emails','embeddings','storage')),
  period text not null check (period in ('daily','monthly')), soft_limit numeric check (soft_limit is null or soft_limit >= 0),
  hard_limit numeric check (hard_limit is null or hard_limit >= 0), action text not null check (action in ('warn','throttle','block','require_approval')),
  ativo boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(organization_id,category,period)
);
create table if not exists public.cost_alerts (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  category text not null check (category in ('ai_tokens','ai_requests','whatsapp_messages','emails','embeddings','storage')),
  threshold_type text not null check (threshold_type in ('soft','hard')),
  status text not null default 'open' check (status in ('open','acknowledged','resolved')), dedup_key text not null unique,
  created_at timestamptz not null default now(), acknowledged_at timestamptz, resolved_at timestamptz, updated_at timestamptz not null default now()
);
-- Reservas ficam separadas do ledger: settle cria consumo definitivo; release
-- apenas cancela. Assim uma chamada externa que nem ocorreu nunca vira custo.
create table if not exists public.usage_reservations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  category text not null check (category in ('ai_tokens','ai_requests','whatsapp_messages','emails','embeddings','storage')),
  quantity numeric not null check(quantity > 0), status text not null default 'reserved' check(status in ('reserved','settled','released')),
  idempotency_key text not null unique, created_at timestamptz not null default now(), settled_at timestamptz, released_at timestamptz
);

alter table public.job_queue enable row level security; alter table public.usage_ledger enable row level security;
alter table public.usage_limits enable row level security; alter table public.cost_alerts enable row level security;
alter table public.usage_reservations enable row level security;
revoke all on public.job_queue,public.usage_ledger,public.usage_limits,public.cost_alerts,public.usage_reservations from public,anon,authenticated;

create or replace function public.job_enqueue(p_id uuid,p_organization_id uuid,p_unit_id uuid,p_job_type text,p_payload text,p_idempotency_key text,p_priority int default 0,p_available_at timestamptz default now(),p_max_attempts int default 5)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare j public.job_queue%rowtype;
begin
 if auth.uid() is not null then raise exception 'forbidden'; end if;
 if p_id is null or nullif(btrim(coalesce(p_payload,'')),'') is null or nullif(btrim(coalesce(p_idempotency_key,'')),'') is null or p_max_attempts<1 then raise exception 'invalid_argument'; end if;
 if p_organization_id is null and p_job_type not in ('system.maintenance') then raise exception 'organization_required'; end if;
 if p_organization_id is not null and not exists(select 1 from public.organizations where id=p_organization_id) then raise exception 'not_found'; end if;
 if p_unit_id is not null and not exists(select 1 from public.units where id=p_unit_id and organization_id=p_organization_id) then raise exception 'unit_not_in_organization'; end if;
 insert into public.job_queue(id,organization_id,unit_id,job_type,payload,idempotency_key,priority,available_at,max_attempts)
 values(p_id,p_organization_id,p_unit_id,p_job_type,p_payload,p_idempotency_key,p_priority,coalesce(p_available_at,now()),p_max_attempts)
 on conflict do nothing returning * into j;
 if not found then select * into j from public.job_queue where job_type=p_job_type and idempotency_key=p_idempotency_key and organization_id is not distinct from p_organization_id; end if;
 return to_jsonb(j);
end;$fn$;

create or replace function public.job_claim(p_worker_id text,p_batch_size int,p_lease_seconds int,p_job_types text[] default null)
returns setof public.job_queue language plpgsql security definer set search_path='' as $fn$
begin
 if auth.uid() is not null then raise exception 'forbidden'; end if;
 if nullif(btrim(coalesce(p_worker_id,'')),'') is null or p_batch_size not between 1 and 100 or p_lease_seconds<1 then raise exception 'invalid_argument'; end if;
 return query with candidates as (
  select id from public.job_queue where ((status in ('pending','retry') and available_at<=now()) or (status='processing' and lease_expires_at<=now()))
   and (p_job_types is null or job_type=any(p_job_types)) order by priority desc,available_at,id for update skip locked limit p_batch_size
 ) update public.job_queue j set status='processing',lease_owner=p_worker_id,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),attempts=j.attempts+1,
 started_at=coalesce(j.started_at,now()),updated_at=now() from candidates c where j.id=c.id returning j.*;
end;$fn$;
create or replace function public.job_heartbeat(p_job_id uuid,p_worker_id text,p_lease_seconds int) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare j public.job_queue%rowtype; begin if auth.uid() is not null then raise exception 'forbidden'; end if;
 update public.job_queue set lease_expires_at=now()+make_interval(secs=>p_lease_seconds),updated_at=now() where id=p_job_id and status='processing' and lease_owner=p_worker_id returning * into j;
 if not found then raise exception 'claim_mismatch'; end if; return to_jsonb(j); end;$fn$;
create or replace function public.job_complete(p_job_id uuid,p_worker_id text) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare j public.job_queue%rowtype; begin if auth.uid() is not null then raise exception 'forbidden'; end if;
 update public.job_queue set status='completed',completed_at=now(),lease_owner=null,lease_expires_at=null,updated_at=now() where id=p_job_id and status='processing' and lease_owner=p_worker_id returning * into j;
 if not found then raise exception 'claim_mismatch'; end if; return to_jsonb(j); end;$fn$;
create or replace function public.job_retry(p_job_id uuid,p_worker_id text,p_error_code text,p_available_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare j public.job_queue%rowtype; terminal boolean; begin if auth.uid() is not null then raise exception 'forbidden'; end if;
 if p_error_code !~ '^[a-z0-9_]{1,64}$' then raise exception 'invalid_error_code'; end if;
 select * into j from public.job_queue where id=p_job_id and status='processing' and lease_owner=p_worker_id for update; if not found then raise exception 'claim_mismatch'; end if;
 terminal:=j.attempts>=j.max_attempts; update public.job_queue set status=case when terminal then 'dead_letter' else 'retry' end,available_at=coalesce(p_available_at,now()),last_error_code=p_error_code,
 lease_owner=null,lease_expires_at=null,completed_at=case when terminal then now() else null end,updated_at=now() where id=j.id returning * into j; return to_jsonb(j); end;$fn$;
create or replace function public.job_cancel(p_organization_id uuid,p_actor_user_id uuid,p_job_id uuid) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare j public.job_queue%rowtype; ar text; begin if auth.uid() is not null and auth.uid()<>p_actor_user_id then raise exception 'forbidden'; end if;
 select * into j from public.job_queue where id=p_job_id and organization_id=p_organization_id for update; if not found then raise exception 'not_found'; end if;
 ar:=public.team_actor_role(p_organization_id,p_actor_user_id); if ar is null or not public.team_actor_is_manager(ar) then raise exception 'forbidden'; end if;
 if j.status not in ('pending','retry','processing') then raise exception 'invalid_state'; end if; update public.job_queue set status='cancelled',completed_at=now(),lease_owner=null,lease_expires_at=null,updated_at=now() where id=j.id returning * into j; return to_jsonb(j); end;$fn$;

-- Janelas daily/monthly sao sempre calculadas em UTC. Advisory lock serializa
-- reservas da mesma org+categoria; limites ativos tambem sao lidos FOR UPDATE.
create or replace function public.usage_reserve(p_organization_id uuid,p_category text,p_quantity numeric,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r public.usage_reservations%rowtype; l record; used numeric; start_at timestamptz; projected numeric; denied boolean:=false; reason text;
begin if auth.uid() is not null then raise exception 'forbidden'; end if;
 if p_quantity<=0 or p_category not in ('ai_tokens','ai_requests','whatsapp_messages','emails','embeddings','storage') or nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'invalid_argument'; end if;
 select * into r from public.usage_reservations where idempotency_key=p_idempotency_key; if found then return jsonb_build_object('allowed',r.status<>'released','reservation_id',r.id,'reason',r.status); end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_category,0));
 for l in select * from public.usage_limits where organization_id=p_organization_id and category=p_category and ativo for update loop
  start_at:=case l.period when 'daily' then date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' else date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' end;
  select coalesce((select sum(quantity) from public.usage_ledger where organization_id=p_organization_id and category=p_category and occurred_at>=start_at),0)+
         coalesce((select sum(quantity) from public.usage_reservations where organization_id=p_organization_id and category=p_category and status='reserved' and created_at>=start_at),0) into used;
  projected:=used+p_quantity;
  if l.hard_limit is not null and projected>l.hard_limit and l.action in ('block','require_approval') then denied:=true; reason:=l.action; end if;
  if l.soft_limit is not null and projected>l.soft_limit and l.action in ('warn','throttle') then
   insert into public.cost_alerts(organization_id,category,threshold_type,dedup_key) values(p_organization_id,p_category,'soft',p_organization_id::text||':'||p_category||':'||l.period||':'||start_at::text||':soft') on conflict(dedup_key) do nothing;
  end if;
 end loop;
 if denied then return jsonb_build_object('allowed',false,'reservation_id',null,'reason',reason); end if;
 insert into public.usage_reservations(organization_id,category,quantity,idempotency_key) values(p_organization_id,p_category,p_quantity,p_idempotency_key) returning * into r;
 return jsonb_build_object('allowed',true,'reservation_id',r.id,'reason',null); end;$fn$;
create or replace function public.usage_settle(p_reservation_id uuid,p_actual_quantity numeric,p_estimated_cost numeric,p_idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r public.usage_reservations%rowtype; l public.usage_ledger%rowtype; begin if auth.uid() is not null then raise exception 'forbidden'; end if;
 select * into l from public.usage_ledger where idempotency_key=p_idempotency_key; if found then return to_jsonb(l); end if;
 select * into r from public.usage_reservations where id=p_reservation_id for update; if not found then raise exception 'not_found'; end if; if r.status='released' then raise exception 'invalid_state'; end if;
 insert into public.usage_ledger(organization_id,category,quantity,estimated_cost,source_type,source_id,idempotency_key) values(r.organization_id,r.category,p_actual_quantity,p_estimated_cost,'reservation',r.id,p_idempotency_key) on conflict(idempotency_key) do update set idempotency_key=excluded.idempotency_key returning * into l;
 update public.usage_reservations set status='settled',settled_at=coalesce(settled_at,now()) where id=r.id; return to_jsonb(l); end;$fn$;
create or replace function public.usage_release(p_reservation_id uuid) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r public.usage_reservations%rowtype; begin if auth.uid() is not null then raise exception 'forbidden'; end if;
 update public.usage_reservations set status='released',released_at=coalesce(released_at,now()) where id=p_reservation_id and status in ('reserved','released') returning * into r;
 if not found then raise exception 'invalid_state'; end if; return to_jsonb(r); end;$fn$;
create or replace function public.usage_aggregate(p_organization_id uuid,p_from timestamptz,p_to timestamptz) returns table(category text,quantity numeric,estimated_cost numeric) language plpgsql security definer set search_path='' as $fn$
begin if auth.uid() is not null then raise exception 'forbidden'; end if; return query select l.category,sum(l.quantity),sum(l.estimated_cost) from public.usage_ledger l where l.organization_id=p_organization_id and l.occurred_at>=p_from and l.occurred_at<p_to group by l.category; end;$fn$;

-- Reserva órfã: um job que foi a dead_letter (ou um worker que morreu) pode
-- deixar uma reserva em 'reserved' que conta contra a quota da organização
-- pra sempre (denial-of-wallet AO CONTRÁRIO — a própria org fica bloqueada).
-- Este sweep libera reservas 'reserved' mais velhas que p_older_than_seconds
-- (default 24h — bem acima de qualquer lease de job legítimo). Backend-only,
-- idempotente, chamado pelo worker de campanha (best-effort).
create or replace function public.usage_reservations_sweep_stale(p_older_than_seconds int default 86400) returns int language plpgsql security definer set search_path='' as $fn$
declare v_count int;
begin
 if auth.uid() is not null then raise exception 'forbidden'; end if;
 with stale as (
   update public.usage_reservations set status='released',released_at=now()
   where status='reserved' and created_at < now() - make_interval(secs=>greatest(p_older_than_seconds,60))
   returning id
 )
 select count(*) into v_count from stale;
 return v_count;
end;$fn$;

-- Vínculo lógico explícito job <-> destinatário (nullable, aditivo — não
-- quebra nada legado). Preenchido pela RPC transacional abaixo.
alter table public.campanha_envios add column if not exists job_id uuid;

-- FASE 2.8 (revisão) — cria/localiza o par (campanha_envios, job_queue) de UM
-- destinatário DENTRO DE UMA ÚNICA TRANSAÇÃO. Substitui o enqueue + upsert
-- separados do dispatch, que NÃO eram atômicos: um worker podia claimar o
-- send antes de campanha_envios existir, ou o dispatch podia sobrescrever um
-- estado terminal com 'enviando'.
--
-- Segurança: SECURITY DEFINER, search_path='', só service_role,
-- backend-only (auth.uid() nulo). idempotency_key é SEMPRE derivada aqui
-- dentro (`campanha:lead`) — NUNCA vem de parâmetro/cliente. Cross-tenant:
-- a campanha tem que pertencer à organização informada E o lead tem que ser
-- do mesmo doctor da campanha. NÃO retorna o payload cifrado.
create or replace function public.campaign_recipient_enqueue(
  p_job_id uuid, p_organization_id uuid, p_campaign_id uuid, p_lead_id uuid, p_payload_encrypted text
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_doctor uuid; v_camp_org uuid;
  v_envio_id uuid; v_envio_status text;
  v_job_id uuid;
  v_idem text := p_campaign_id::text || ':' || p_lead_id::text;
  v_created_job boolean := false; v_created_envio boolean := false;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;
  if p_job_id is null or p_organization_id is null or p_campaign_id is null or p_lead_id is null
     or nullif(btrim(coalesce(p_payload_encrypted,'')),'') is null then raise exception 'invalid_argument'; end if;

  select c.doctor_id, c.organization_id into v_doctor, v_camp_org from public.campanhas c where c.id = p_campaign_id;
  if not found then raise exception 'not_found'; end if;
  if v_camp_org is null or v_camp_org <> p_organization_id then raise exception 'forbidden'; end if;
  if not exists (select 1 from public.leads l where l.id = p_lead_id and l.doctor_id = v_doctor) then raise exception 'forbidden'; end if;

  select id, status into v_envio_id, v_envio_status
    from public.campanha_envios where campanha_id = p_campaign_id and lead_id = p_lead_id for update;
  select id into v_job_id from public.job_queue
    where organization_id = p_organization_id and job_type = 'campaign.send_message' and idempotency_key = v_idem for update;

  -- ESTADO TERMINAL (qualquer coisa diferente de 'enviando'): não recria job,
  -- não rebaixa. Um reenvio manual futuro precisa de uma operação/chave
  -- própria — não é retry de dispatch.
  if v_envio_id is not null and v_envio_status is distinct from 'enviando' then
    return jsonb_build_object('job_id', v_job_id, 'ledger_id', v_envio_id, 'created', false, 'terminal', true, 'envio_status', v_envio_status);
  end if;

  if v_envio_id is null then
    insert into public.campanha_envios (campanha_id, lead_id, status)
      values (p_campaign_id, p_lead_id, 'enviando')
      on conflict (campanha_id, lead_id) do nothing returning id into v_envio_id;
    if v_envio_id is null then
      -- corrida: outra transação criou entre o select e o insert
      select id, status into v_envio_id, v_envio_status from public.campanha_envios where campanha_id = p_campaign_id and lead_id = p_lead_id;
      if v_envio_status is distinct from 'enviando' then
        return jsonb_build_object('job_id', v_job_id, 'ledger_id', v_envio_id, 'created', false, 'terminal', true, 'envio_status', v_envio_status);
      end if;
    else
      v_created_envio := true;
    end if;
  end if;

  if v_job_id is null then
    insert into public.job_queue (id, organization_id, job_type, payload, idempotency_key)
      values (p_job_id, p_organization_id, 'campaign.send_message', p_payload_encrypted, v_idem)
      on conflict do nothing returning id into v_job_id;
    if v_job_id is null then
      select id into v_job_id from public.job_queue where organization_id = p_organization_id and job_type = 'campaign.send_message' and idempotency_key = v_idem;
    else
      v_created_job := true;
    end if;
  end if;

  update public.campanha_envios set job_id = v_job_id where id = v_envio_id and job_id is distinct from v_job_id;

  return jsonb_build_object(
    'job_id', v_job_id, 'ledger_id', v_envio_id,
    'created', (v_created_job or v_created_envio),
    'created_job', v_created_job, 'created_envio', v_created_envio, 'terminal', false
  );
end;$fn$;

do $grants$ declare r record; begin for r in select p.oid::regprocedure sig from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('job_enqueue','job_claim','job_heartbeat','job_complete','job_retry','job_cancel','usage_reserve','usage_settle','usage_release','usage_aggregate','usage_reservations_sweep_stale','campaign_recipient_enqueue') loop execute format('revoke execute on function %s from public',r.sig); execute format('revoke execute on function %s from anon,authenticated',r.sig); execute format('grant execute on function %s to service_role',r.sig); end loop; end;$grants$;
