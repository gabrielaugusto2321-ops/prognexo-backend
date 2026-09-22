-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.

drop function if exists public.doctor_access_gate(uuid, uuid);

alter table public.doctors
  drop column if exists courtesy_expires_at;
