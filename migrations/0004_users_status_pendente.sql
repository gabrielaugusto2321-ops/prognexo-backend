-- FASE 1A/R03: estado explícito de conta (pending/active/suspended).
-- Multi-passo para NÃO transformar usuários atuais em pendentes. REVIEW; DO NOT auto-apply.

-- 1. Coluna sem default e sem NOT NULL — não quebra nenhum registro existente.
alter table public.users add column if not exists status text;

-- 2. Backfill seguro dos registros que já existem:
--    - quem já podia entrar (ativo = true)  -> 'active'
--    - quem estava bloqueado (ativo = false / null) -> 'suspended'
--      (continua bloqueado; NUNCA vira 'pending', que permitiria auto-ativação)
update public.users set status = 'active'    where status is null and ativo is true;
update public.users set status = 'suspended' where status is null and (ativo is false or ativo is null);

-- 3. Só agora aplica default, NOT NULL e a constraint de domínio.
alter table public.users alter column status set default 'pending';
alter table public.users alter column status set not null;
alter table public.users
  add constraint users_status_check check (status in ('pending', 'active', 'suspended'));
