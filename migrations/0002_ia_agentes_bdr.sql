-- Segundo tipo de agente de IA: BDR (prospecção ativa, sob demanda)
-- ------------------------------------------------------------------
-- Diferente do SDR, o BDR NÃO qualifica lead automaticamente e NÃO roda
-- sozinho no webhook do WhatsApp. Ele só ajuda a redigir mensagens de
-- prospecção quando o médico pede — por isso a config é bem mais enxuta
-- (sem score, critérios ou limite de mensagens).
--
-- 1 agente BDR por médico (unique em doctor_id).
--
-- REVISAR antes de aplicar no Supabase de produção.

create table if not exists public.ia_agentes_bdr (
  id         uuid primary key default gen_random_uuid(),
  doctor_id  uuid not null unique references public.doctors(id) on delete cascade,
  nome       text not null default 'BDR',
  contexto   text,
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);

-- Segue o padrão das outras tabelas: RLS ligada, sem policies — o
-- backend usa a service role key e faz o controle de acesso por
-- doctor_id na aplicação. (A constraint UNIQUE já cria o índice de
-- doctor_id, não precisa de um índice extra.)
alter table public.ia_agentes_bdr enable row level security;
