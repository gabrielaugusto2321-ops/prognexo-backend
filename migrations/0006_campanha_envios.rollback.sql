-- Rollback de 0006.
alter table public.campanhas drop column if exists processando_desde;
drop table if exists public.campanha_envios;
