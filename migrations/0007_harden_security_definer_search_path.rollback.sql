-- Rollback de 0007 — volta os helpers ao estado do baseline (sem search_path,
-- EXECUTE para anon). NÃO recomendado — o rollback restaura a fragilidade.
create or replace function public.is_admin()
returns boolean language sql security definer as $$
  select exists(select 1 from public.users where id = auth.uid() and role = 'admin');
$$;
create or replace function public.is_doctor_owner(target_doctor_id uuid)
returns boolean language sql security definer as $$
  select exists(select 1 from public.doctors where id = target_doctor_id and owner_user_id = auth.uid());
$$;
create or replace function public.user_has_doctor_access(target_doctor_id uuid)
returns boolean language sql security definer as $$
  select exists(select 1 from public.user_doctor_access where doctor_id = target_doctor_id and user_id = auth.uid());
$$;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_doctor_owner(uuid) to anon, authenticated;
grant execute on function public.user_has_doctor_access(uuid) to anon, authenticated;
