-- Rollback somente dos objetos criados pela migration 0015.
-- NAO remove nem altera nenhuma outra coluna, constraint, policy ou grant.

alter table public.leads drop constraint if exists leads_feedback_ia_check;
alter table public.leads drop column if exists feedback_ia_by;
alter table public.leads drop column if exists feedback_ia_at;
alter table public.leads drop column if exists feedback_ia;
