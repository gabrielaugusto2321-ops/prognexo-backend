-- FASE 1A/R01: deny browser roles until tenant-aware policies exist.
-- Backend service-role access is intentionally unaffected. REVIEW; DO NOT auto-apply.
drop policy if exists "service_role_all_campanhas" on public.campanhas;
drop policy if exists "service_role_all_knowledge_base" on public.knowledge_base;
revoke all on public.campanhas from anon, authenticated;
revoke all on public.knowledge_base from anon, authenticated;
revoke all on public.knowledge_chunks from anon, authenticated;
alter table public.campanhas enable row level security;
alter table public.knowledge_base enable row level security;
alter table public.knowledge_chunks enable row level security;
