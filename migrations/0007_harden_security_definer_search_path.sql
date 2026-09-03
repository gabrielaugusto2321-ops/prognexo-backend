-- FASE 1B.2A — hardening dos helpers SECURITY DEFINER de RLS.
-- Achado da revisão adversarial (também advisor 0011/0028 da FASE 0):
-- is_admin() / is_doctor_owner() / user_has_doctor_access() são SECURITY DEFINER
-- sem `set search_path` — abre espaço para search_path hijack.
--
-- Fix: fixar `search_path = ''` (referências já são totalmente qualificadas com
-- `public.`), tornar `stable`, e restringir o EXECUTE a `authenticated`
-- (não faz sentido `anon` chamar via /rest/v1/rpc).
-- REVIEW; DO NOT auto-apply.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_doctor_owner(target_doctor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1 from public.doctors
    where id = target_doctor_id and owner_user_id = auth.uid()
  );
$$;

create or replace function public.user_has_doctor_access(target_doctor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1 from public.user_doctor_access
    where doctor_id = target_doctor_id and user_id = auth.uid()
  );
$$;

revoke execute on function public.is_admin() from anon;
revoke execute on function public.is_doctor_owner(uuid) from anon;
revoke execute on function public.user_has_doctor_access(uuid) from anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_doctor_owner(uuid) to authenticated;
grant execute on function public.user_has_doctor_access(uuid) to authenticated;
