-- Rollback ESTRUTURAL da 0010. NÃO apaga dados legados nem doctor_id.
-- Remove só o que a 0010 adicionou. Colunas organization_id ficam (nullable,
-- inofensivas) — descomente os DROPs se realmente necessário.

drop policy if exists atendimentos_org_admin_all on public.atendimentos;
drop policy if exists atendimentos_org_scoped    on public.atendimentos;

drop trigger if exists trg_leads_org_propagate  on public.leads;
drop trigger if exists trg_transactions_org      on public.transactions;
drop trigger if exists trg_atendimentos_org      on public.atendimentos;
drop trigger if exists trg_conversations_org     on public.conversations;

drop function if exists public.propagate_lead_org();
drop function if exists public.backfill_tenant_expansion();
drop function if exists public.enforce_org_from_deal();
drop function if exists public.enforce_org_from_lead();
drop function if exists public.org_of_deal(uuid);
drop function if exists public.org_of_lead(uuid);

drop index if exists public.conversations_org_idx;
drop index if exists public.transactions_org_idx;
drop index if exists public.atendimentos_org_idx;
drop index if exists public.knowledge_base_org_idx;
drop index if exists public.knowledge_chunks_org_idx;
drop index if exists public.ia_agentes_bdr_org_idx;

-- colunas aditivas (seguras de manter; DROP opcional)
-- alter table public.conversations    drop column if exists organization_id;
-- alter table public.transactions     drop column if exists organization_id;
-- alter table public.atendimentos     drop column if exists organization_id;
-- alter table public.knowledge_base   drop column if exists organization_id;
-- alter table public.knowledge_chunks drop column if exists organization_id;
-- alter table public.ia_agentes_bdr   drop column if exists organization_id;
