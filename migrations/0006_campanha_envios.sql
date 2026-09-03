-- FASE 1A.2/RACE01: ledger de envio por (campanha, lead) para idempotência.
-- Impede reenvio da mesma campanha para o mesmo lead em retomadas. REVIEW; DO NOT auto-apply.
--
-- Também adiciona `campanhas.processando_desde` para detectar um envio órfão
-- (processo reiniciou no meio) e permitir retomada segura.
--
-- Os estados 'processando' e 'erro' de `campanhas.status` precisam ser aceitos.
-- Como não há CHECK versionado nessa coluna hoje, isto é um no-op se a coluna
-- for texto livre; se existir um enum/CHECK, ajuste-o aqui.

create table if not exists public.campanha_envios (
  id          uuid primary key default gen_random_uuid(),
  campanha_id uuid not null references public.campanhas(id) on delete cascade,
  lead_id     uuid not null references public.leads(id) on delete cascade,
  status      text not null default 'enviando',  -- enviando | enviado | pendente_template | falhou
  enviado_em  timestamptz,
  criado_em   timestamptz not null default now(),
  unique (campanha_id, lead_id)
);

create index if not exists campanha_envios_campanha_idx on public.campanha_envios (campanha_id);

-- Marca de quando um envio entrou em processamento. Um envio 'processando' com
-- `processando_desde` antigo (> 15 min) é considerado órfão e pode ser retomado.
alter table public.campanhas add column if not exists processando_desde timestamptz;

-- Segue o padrão do projeto: RLS ligada, sem policy — só a service role do
-- backend acessa. Nenhum acesso de anon/authenticated.
alter table public.campanha_envios enable row level security;
revoke all on public.campanha_envios from anon, authenticated;
