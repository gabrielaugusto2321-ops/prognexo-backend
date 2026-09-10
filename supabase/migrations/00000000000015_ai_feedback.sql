-- FASE 3.3A - feedback humano da Auditoria de IA (aditiva, Postgres-only).
-- REVIEW; DO NOT auto-apply. Nunca aplicar em ambiente remoto.
--
-- Corrige o bug pre-existente: a tela Auditoria envia uma avaliacao ('bom' /
-- 'ruim') para uma conversa que a IA entregou, mas nao havia coluna para
-- persistir isso e o `updateSchema` de /leads (`.strict()`) rejeitava o campo.
--
-- Adiciona 3 colunas em `public.leads`:
--   feedback_ia     - a avaliacao humana ('bom' | 'ruim' | NULL = nao avaliado)
--   feedback_ia_at  - quando foi avaliado (server-side)
--   feedback_ia_by  - quem avaliou (server-side, do JWT)
--
-- Nenhuma coluna existente e removida, renomeada ou marcada NOT NULL.
-- Nenhum dado historico e inventado (todas as linhas ficam feedback_ia = NULL).

alter table public.leads
  add column if not exists feedback_ia    text,
  add column if not exists feedback_ia_at timestamptz,
  add column if not exists feedback_ia_by uuid references public.users(id) on delete set null;

-- CHECK estrito: so os dois valores que a Auditoria realmente grava. A aba
-- "reuniao" da tela e derivada de status_atual, nao e um valor de feedback.
alter table public.leads
  drop constraint if exists leads_feedback_ia_check;
alter table public.leads
  add constraint leads_feedback_ia_check
  check (feedback_ia is null or feedback_ia in ('bom', 'ruim'));

-- Sem indice: a Auditoria carrega os leads com `ia_motivo_handoff` preenchido
-- e filtra as abas (bom/ruim/pendentes) em memoria. Nao ha consulta por
-- `feedback_ia` isolado que justifique um indice.

-- Grants: `feedback_ia*` NAO entra no grant de UPDATE do papel `authenticated`.
-- O grant minimo do browser continua sendo `(status_atual, dados_extraidos)`
-- (AR-2 da migration 0008). Toda escrita de feedback passa pela API
-- (service-role, via PATCH /leads/:id/ai-feedback) — o browser nunca seta este
-- campo direto pelo PostgREST.

-- As policies de RLS de `leads` sao row-level ('for all' / 'for update') e ja
-- cobrem as novas colunas sem alteracao. Nenhuma policy nova e necessaria.
