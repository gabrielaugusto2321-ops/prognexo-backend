-- =====================================================================
-- FASE 2.3 — Expansão do tenancy (ADITIVA).
--
-- Estende o núcleo multitenant da 0008 para os módulos ainda doctor-scoped:
--   conversations, transactions, atendimentos, knowledge_base,
--   knowledge_chunks, ia_agentes_bdr.
--
-- Preserva 100%: doctor_id, todas as tabelas/colunas legadas, RLS existente.
-- organization_id entra NULLABLE; consistência garantida por TRIGGER (não por
-- CHECK, que não pode consultar o parent). Nenhuma constraint NOT NULL aqui.
-- Idempotente. Rollback em 0010_tenant_expansion.rollback.sql.
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Colunas ADITIVAS — nullable, FK para organizations, + índice.
-- ---------------------------------------------------------------------
alter table public.conversations   add column if not exists organization_id uuid references public.organizations(id);
alter table public.transactions    add column if not exists organization_id uuid references public.organizations(id);
alter table public.atendimentos    add column if not exists organization_id uuid references public.organizations(id);
alter table public.knowledge_base  add column if not exists organization_id uuid references public.organizations(id);
alter table public.knowledge_chunks add column if not exists organization_id uuid references public.organizations(id);
alter table public.ia_agentes_bdr  add column if not exists organization_id uuid references public.organizations(id);

create index if not exists conversations_org_idx    on public.conversations (organization_id);
create index if not exists transactions_org_idx     on public.transactions (organization_id);
create index if not exists atendimentos_org_idx     on public.atendimentos (organization_id);
create index if not exists knowledge_base_org_idx   on public.knowledge_base (organization_id);
create index if not exists knowledge_chunks_org_idx on public.knowledge_chunks (organization_id);
create index if not exists ia_agentes_bdr_org_idx   on public.ia_agentes_bdr (organization_id);

-- ---------------------------------------------------------------------
-- 2. Helpers de derivação de tenant (SECURITY DEFINER, search_path fixo).
-- ---------------------------------------------------------------------
create or replace function public.org_of_lead(p_lead uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select organization_id from public.leads where id = p_lead;
$$;

create or replace function public.org_of_deal(p_deal uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select l.organization_id
  from public.deals d
  join public.leads l on l.id = d.lead_id
  where d.id = p_deal;
$$;

revoke execute on function public.org_of_lead(uuid)  from anon, authenticated;
revoke execute on function public.org_of_deal(uuid)  from anon, authenticated;
grant  execute on function public.org_of_lead(uuid)  to service_role;
grant  execute on function public.org_of_deal(uuid)  to service_role;

-- ---------------------------------------------------------------------
-- 3. Trigger de consistência: organization_id do filho SEMPRE bate com o parent.
--    - INSERT/UPDATE com organization_id NULL   -> preenchido a partir do parent
--    - INSERT/UPDATE com organization_id != parent -> EXCEPTION (falha fechada)
--    - o valor do body nunca "vence" o parent
-- ---------------------------------------------------------------------
create or replace function public.enforce_org_from_lead()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare v_org uuid;
begin
  v_org := public.org_of_lead(new.lead_id);
  if v_org is null then
    -- parent ainda sem tenant: não inventa, mantém NULL (backfill/issue cuida)
    new.organization_id := null;
    return new;
  end if;
  if new.organization_id is null then
    new.organization_id := v_org;
  elsif new.organization_id <> v_org then
    raise exception 'tenant_mismatch: %.organization_id (%) != organização do lead % (%)',
      tg_table_name, new.organization_id, new.lead_id, v_org
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

create or replace function public.enforce_org_from_deal()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare v_org uuid;
begin
  if new.deal_id is null then
    -- transação sem deal casado (webhook antes do match): tenant não derivável
    new.organization_id := null;
    return new;
  end if;
  v_org := public.org_of_deal(new.deal_id);
  if v_org is null then
    new.organization_id := null;
    return new;
  end if;
  if new.organization_id is null then
    new.organization_id := v_org;
  elsif new.organization_id <> v_org then
    raise exception 'tenant_mismatch: transactions.organization_id (%) != organização do deal % (%)',
      new.organization_id, new.deal_id, v_org
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

revoke execute on function public.enforce_org_from_lead() from anon, authenticated;
revoke execute on function public.enforce_org_from_deal() from anon, authenticated;

drop trigger if exists trg_conversations_org on public.conversations;
create trigger trg_conversations_org
  before insert or update of organization_id, lead_id on public.conversations
  for each row execute function public.enforce_org_from_lead();

drop trigger if exists trg_atendimentos_org on public.atendimentos;
create trigger trg_atendimentos_org
  before insert or update of organization_id, lead_id on public.atendimentos
  for each row execute function public.enforce_org_from_lead();

drop trigger if exists trg_transactions_org on public.transactions;
create trigger trg_transactions_org
  before insert or update of organization_id, deal_id on public.transactions
  for each row execute function public.enforce_org_from_deal();

-- ---------------------------------------------------------------------
-- 4. Propagação quando o PARENT muda de organização (raro, mas coberto).
--    Se leads.organization_id muda, os filhos diretos e as transações via deal
--    acompanham — nenhum registro fica cross-tenant silenciosamente.
-- ---------------------------------------------------------------------
create or replace function public.propagate_lead_org()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  if new.organization_id is distinct from old.organization_id then
    update public.conversations set organization_id = new.organization_id where lead_id = new.id;
    update public.atendimentos  set organization_id = new.organization_id where lead_id = new.id;
    update public.transactions t set organization_id = new.organization_id
      from public.deals d where d.id = t.deal_id and d.lead_id = new.id;
  end if;
  return new;
end $fn$;

revoke execute on function public.propagate_lead_org() from anon, authenticated;

drop trigger if exists trg_leads_org_propagate on public.leads;
create trigger trg_leads_org_propagate
  after update of organization_id on public.leads
  for each row execute function public.propagate_lead_org();

-- ---------------------------------------------------------------------
-- 5. BACKFILL — idempotente. NUNCA escolhe tenant silenciosamente;
--    o que não dá para mapear vai para tenant_backfill_issues.
-- ---------------------------------------------------------------------
create or replace function public.backfill_tenant_expansion()
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  -- 5.1 tabelas com doctor_id -> via organization_doctor_map
  update public.knowledge_base kb set organization_id = m.organization_id
    from public.organization_doctor_map m
    where m.doctor_id = kb.doctor_id and kb.organization_id is null;
  update public.knowledge_chunks kc set organization_id = m.organization_id
    from public.organization_doctor_map m
    where m.doctor_id = kc.doctor_id and kc.organization_id is null;
  update public.ia_agentes_bdr a set organization_id = m.organization_id
    from public.organization_doctor_map m
    where m.doctor_id = a.doctor_id and a.organization_id is null;

  -- 5.2 tabelas sem doctor_id -> via lead/deal já com organization_id (0008)
  update public.conversations c set organization_id = l.organization_id
    from public.leads l
    where l.id = c.lead_id and l.organization_id is not null and c.organization_id is null;
  update public.atendimentos at set organization_id = l.organization_id
    from public.leads l
    where l.id = at.lead_id and l.organization_id is not null and at.organization_id is null;
  update public.transactions t set organization_id = l.organization_id
    from public.deals d
    join public.leads l on l.id = d.lead_id
    where d.id = t.deal_id and l.organization_id is not null and t.organization_id is null;

  -- 5.3 ambiguidades -> issues (sem membership/organização atribuída)
  insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
  select 'kb_doctor_unmapped', 'knowledge_base', kb.id::text, jsonb_build_object('doctor_id', kb.doctor_id)
  from public.knowledge_base kb where kb.organization_id is null
  on conflict do nothing;

  insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
  select 'kb_chunk_doctor_unmapped', 'knowledge_chunks', kc.id::text, jsonb_build_object('doctor_id', kc.doctor_id)
  from public.knowledge_chunks kc where kc.organization_id is null
  on conflict do nothing;

  insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
  select 'bdr_agent_doctor_unmapped', 'ia_agentes_bdr', a.id::text, jsonb_build_object('doctor_id', a.doctor_id)
  from public.ia_agentes_bdr a where a.organization_id is null
  on conflict do nothing;

  insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
  select 'conversation_lead_unmapped', 'conversations', c.id::text, jsonb_build_object('lead_id', c.lead_id)
  from public.conversations c where c.organization_id is null
  on conflict do nothing;

  insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
  select 'atendimento_lead_unmapped', 'atendimentos', at.id::text, jsonb_build_object('lead_id', at.lead_id)
  from public.atendimentos at where at.organization_id is null
  on conflict do nothing;

  -- transação SEM deal_id não é ambiguidade (é estado legítimo de webhook não casado)
  insert into public.tenant_backfill_issues (kind, subject_type, subject_id, detail)
  select 'transaction_lead_unmapped', 'transactions', t.id::text, jsonb_build_object('deal_id', t.deal_id)
  from public.transactions t where t.organization_id is null and t.deal_id is not null
  on conflict do nothing;
end $fn$;

revoke execute on function public.backfill_tenant_expansion() from anon, authenticated;

select public.backfill_tenant_expansion();

-- ---------------------------------------------------------------------
-- 6. RLS / grants.
--    conversations, transactions, knowledge_base, knowledge_chunks,
--    ia_agentes_bdr permanecem DENY-ALL para o browser (backend-only via
--    service-role + tenantContext). Nada é exposto de novo.
--    atendimentos JÁ tem policy doctor-scoped -> ganha policy org EQUIVALENTE (OR).
-- ---------------------------------------------------------------------
revoke all on public.conversations    from anon, authenticated;
revoke all on public.transactions     from anon, authenticated;
revoke all on public.knowledge_base   from anon, authenticated;
revoke all on public.knowledge_chunks from anon, authenticated;
revoke all on public.ia_agentes_bdr   from anon, authenticated;

drop policy if exists atendimentos_org_scoped on public.atendimentos;
create policy atendimentos_org_scoped on public.atendimentos
  for all
  using (organization_id is not null and public.is_org_member(organization_id))
  with check (organization_id is not null and public.is_org_member(organization_id));

drop policy if exists atendimentos_org_admin_all on public.atendimentos;
create policy atendimentos_org_admin_all on public.atendimentos
  for all using (public.is_platform_admin());
