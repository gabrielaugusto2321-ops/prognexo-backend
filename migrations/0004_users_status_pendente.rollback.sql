-- Rollback de 0004. Remove a constraint e a coluna `status`.
-- A coluna `ativo` continua sendo a fonte de verdade após o rollback.
alter table public.users drop constraint if exists users_status_check;
alter table public.users alter column status drop not null;
alter table public.users alter column status drop default;
alter table public.users drop column if exists status;
