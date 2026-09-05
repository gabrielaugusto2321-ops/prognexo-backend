-- Rollback somente dos objetos criados pela migration 0014.
drop function if exists public.campaign_recipient_enqueue(uuid,uuid,uuid,uuid,text);
alter table public.campanha_envios drop column if exists job_id;
drop function if exists public.usage_reservations_sweep_stale(int);
drop function if exists public.usage_aggregate(uuid,timestamptz,timestamptz);
drop function if exists public.usage_release(uuid);
drop function if exists public.usage_settle(uuid,numeric,numeric,text);
drop function if exists public.usage_reserve(uuid,text,numeric,text);
drop function if exists public.job_cancel(uuid,uuid,uuid);
drop function if exists public.job_retry(uuid,text,text,timestamptz);
drop function if exists public.job_complete(uuid,text);
drop function if exists public.job_heartbeat(uuid,text,int);
drop function if exists public.job_claim(text,int,int,text[]);
drop function if exists public.job_enqueue(uuid,uuid,uuid,text,text,text,int,timestamptz,int);
drop table if exists public.usage_reservations;
drop table if exists public.cost_alerts;
drop table if exists public.usage_limits;
drop table if exists public.usage_ledger;
drop table if exists public.job_queue;
