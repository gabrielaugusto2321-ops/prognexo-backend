-- INSECURE BY DESIGN emergency rollback: restores the exact previously audited exposure.
create policy "service_role_all_campanhas" on public.campanhas for all to public using (true) with check (true);
create policy "service_role_all_knowledge_base" on public.knowledge_base for all to public using (true) with check (true);
grant all on public.campanhas to anon, authenticated;
grant all on public.knowledge_base to anon, authenticated;
grant all on public.knowledge_chunks to anon, authenticated;
