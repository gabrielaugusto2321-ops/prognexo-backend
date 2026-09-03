-- =====================================================================
-- BASELINE LOCAL — reproduz o schema base do Prognexo para testes de RLS.
--
-- FONTES (rastreabilidade):
--   [C]  confirmado pelo código (src/**/*.js — .from/.select/.insert/.update)
--   [A]  confirmado pela auditoria da FASE 0 (00-current-state-audit.md §2.4,
--        02-threat-model.md — introspecção read-only do projeto real)
--   [I]  inferido (tipo/constraint plausível, não observado diretamente)
--
-- Limitado ao necessário para os testes locais de RLS + migrations 0003-0006 + seed.
-- SEM tabelas profeta_*. SEM dados. SEM credenciais.
-- As policies são reproduzidas EXATAMENTE como capturadas na FASE 0 (role `public`,
-- mesmas expressões USING) — o objetivo é provar a isolação REAL, não uma ideal.
-- As funções SECURITY DEFINER são reproduzidas fielmente (inclusive SEM
-- `set search_path` — é assim em produção; a revisão adversarial anota isso).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

-- Grants padrão do Supabase para o schema public (produção concede tudo a
-- anon/authenticated; a isolação vem da RLS). [A]
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- users  [C: id, nome, email, role, ativo, criado_em]
-- (migration 0004 adiciona `status` — NÃO incluir aqui)
-- ---------------------------------------------------------------------
create table public.users (
  id         uuid primary key,                         -- = auth.users.id [C]
  nome       text,
  email      text unique,
  role       text not null default 'doctor'
             check (role in ('admin', 'doctor', 'closer')),   -- [C/I]
  ativo      boolean not null default true,            -- [C]
  criado_em  timestamptz not null default now()        -- [C]
);

-- ---------------------------------------------------------------------
-- doctors (tenant atual)  [C: owner_user_id, nome, status, plano, modulo,
--   periodicidade, distribuicao_automatica, asaas_*, assinatura_status, ia_*]
-- ---------------------------------------------------------------------
create table public.doctors (
  id                      uuid primary key default gen_random_uuid(),
  owner_user_id           uuid references public.users(id) on delete set null,  -- [C]
  nome                    text,
  especialidade           text,                        -- [C] (doctors.js insert)
  telefone                text,                        -- [C]
  email                   text,                        -- [C]
  status                  text not null default 'ativo',        -- [C]
  plano                   text not null default 'gratuito',     -- [C]
  modulo                  text,                        -- [C]
  periodicidade           text,                        -- [C]
  distribuicao_automatica boolean not null default false,       -- [C]
  asaas_customer_id       text,                        -- [C]
  asaas_subscription_id   text,                        -- [C]
  assinatura_status       text,                        -- [C]
  ia_atendimento_ativo    boolean not null default false,       -- [C]
  ia_contexto             text,                        -- [C]
  ia_nome_agente          text,                        -- [C]
  ia_palavras_proibidas   text,                        -- [C]
  ia_score_minimo         integer,                     -- [C]
  ia_criterios            jsonb,                       -- [C/I]
  ia_limite_mensagens     integer,                     -- [C]
  criado_em               timestamptz not null default now()    -- [C]
);
create index doctors_owner_idx on public.doctors (owner_user_id);

-- ---------------------------------------------------------------------
-- user_doctor_access (membership atual: closer <-> doctor)  [C]
-- ---------------------------------------------------------------------
create table public.user_doctor_access (
  user_id   uuid not null references public.users(id) on delete cascade,
  doctor_id uuid not null references public.doctors(id) on delete cascade,
  primary key (user_id, doctor_id)
);

-- ---------------------------------------------------------------------
-- products  [C: doctor_id, nome, preco, ia_contexto]
-- ---------------------------------------------------------------------
create table public.products (
  id         uuid primary key default gen_random_uuid(),
  doctor_id  uuid references public.doctors(id) on delete cascade,   -- [C via deals join / policy deny-all]
  nome       text,
  preco      numeric(14,2),
  ia_contexto text
);

-- ---------------------------------------------------------------------
-- leads  [C: doctor_id, nome, email, telefone, status_atual, journey_type,
--   sdr_responsavel_id, atendido_por, dados_extraidos, ia_score,
--   ia_mensagens_enviadas, ia_sem_resposta_count, ia_motivo_handoff,
--   product_id, criado_em]
-- ---------------------------------------------------------------------
create table public.leads (
  id                     uuid primary key default gen_random_uuid(),
  doctor_id              uuid not null references public.doctors(id) on delete cascade,  -- [C]
  nome                   text,
  email                  text,
  telefone               text,
  status_atual           text not null default 'lead',   -- [C]
  journey_type           text not null default 'low_ticket',  -- [C]
  sdr_responsavel_id     uuid references public.users(id) on delete set null,  -- [C]
  atendido_por           text,                           -- [C] ('humano'|'ia')
  dados_extraidos        jsonb,                          -- [C]
  ia_score               integer,                        -- [C]
  ia_mensagens_enviadas  integer not null default 0,     -- [C]
  ia_sem_resposta_count  integer not null default 0,     -- [C]
  ia_motivo_handoff      text,                           -- [C]
  product_id             uuid references public.products(id) on delete set null,  -- [C]
  criado_em              timestamptz not null default now()  -- [C]
);
create index leads_doctor_idx on public.leads (doctor_id);
create index leads_sdr_idx on public.leads (sdr_responsavel_id);

-- ---------------------------------------------------------------------
-- deals  [C: lead_id, product_id, etapa, motivo_perda, sdr_responsavel_id,
--   valor, atualizado_em]
-- ---------------------------------------------------------------------
create table public.deals (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid not null references public.leads(id) on delete cascade,  -- [C]
  product_id         uuid references public.products(id) on delete set null,
  etapa              text not null default 'lead',   -- [C]
  motivo_perda       text,                           -- [C]
  sdr_responsavel_id uuid references public.users(id) on delete set null,  -- [C]
  valor              numeric(14,2),                  -- [C]
  atualizado_em      timestamptz not null default now()  -- [C]
);
create index deals_lead_idx on public.deals (lead_id);

-- ---------------------------------------------------------------------
-- conversations  [C: lead_id, canal, direcao, conteudo, origem, timestamp_msg]
-- ---------------------------------------------------------------------
create table public.conversations (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads(id) on delete cascade,  -- [C]
  canal         text,             -- [C] 'whatsapp'
  direcao       text,             -- [C] 'recebida'|'enviada'
  conteudo      text,             -- [C]
  origem        text,             -- [C] 'automatico'|'manual'
  timestamp_msg timestamptz not null default now()  -- [C]
);
create index conversations_lead_idx on public.conversations (lead_id);

-- ---------------------------------------------------------------------
-- events  [C: doctor_id, lead_id, tipo, titulo, inicio, fim, responsavel_id,
--   status, google_event_id]
-- ---------------------------------------------------------------------
create table public.events (
  id              uuid primary key default gen_random_uuid(),
  doctor_id       uuid not null references public.doctors(id) on delete cascade,  -- [C]
  lead_id         uuid references public.leads(id) on delete set null,            -- [C]
  tipo            text,     -- [C]
  titulo          text,     -- [C]
  inicio          timestamptz,  -- [C]
  fim             timestamptz,  -- [C]
  responsavel_id  uuid references public.users(id) on delete set null,  -- [C]
  status          text not null default 'pendente'
                  check (status in ('pendente','compareceu','faltou','cancelado')),  -- [C]
  google_event_id text     -- [C]
);
create index events_doctor_idx on public.events (doctor_id);

-- ---------------------------------------------------------------------
-- atendimentos  [C: lead_id, event_id, data, valor, compareceu]
-- ---------------------------------------------------------------------
create table public.atendimentos (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads(id) on delete cascade,  -- [C]
  event_id   uuid references public.events(id) on delete set null,         -- [C]
  data       timestamptz,   -- [C]
  valor      numeric(14,2), -- [C]
  compareceu boolean        -- [C]
);

-- ---------------------------------------------------------------------
-- integrations  [C: doctor_id, gateway, external_id, access_token,
--   webhook_token, waba_id] + upsert onConflict (doctor_id, gateway)
-- ---------------------------------------------------------------------
create table public.integrations (
  id            uuid primary key default gen_random_uuid(),
  doctor_id     uuid not null references public.doctors(id) on delete cascade,  -- [C]
  gateway       text not null,   -- [C]
  external_id   text,            -- [C]
  access_token  text,            -- [C] (segredo — texto puro, como em produção [A])
  webhook_token text default encode(extensions.gen_random_bytes(16), 'hex'),  -- [C/I]
  waba_id       text,            -- [C]
  unique (doctor_id, gateway)    -- [C: onConflict 'doctor_id,gateway']
);

-- ---------------------------------------------------------------------
-- google_tokens  [C: user_id, refresh_token, access_token, expiry, calendar_id]
-- ---------------------------------------------------------------------
create table public.google_tokens (
  user_id       uuid primary key references public.users(id) on delete cascade,  -- [C]
  refresh_token text,   -- [C]
  access_token  text,   -- [C]
  expiry        timestamptz,  -- [C]
  calendar_id   text    -- [C]
);

-- ---------------------------------------------------------------------
-- knowledge_base  [C: doctor_id, titulo, conteudo, ativo, criado_em]
-- ---------------------------------------------------------------------
create table public.knowledge_base (
  id        uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references public.doctors(id) on delete cascade,  -- [C]
  titulo    text,   -- [C]
  conteudo  text,   -- [C]
  ativo     boolean not null default true,  -- [C]
  criado_em timestamptz not null default now()  -- [C]
);

-- ---------------------------------------------------------------------
-- knowledge_chunks  [A: migration 0001 do repo]
-- (embedding como vector(1024); não exercido pelos testes de RLS)
-- ---------------------------------------------------------------------
create table public.knowledge_chunks (
  id                uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references public.knowledge_base(id) on delete cascade,
  doctor_id         uuid not null references public.doctors(id) on delete cascade,
  titulo            text,
  conteudo          text not null,
  chunk_index       integer not null default 0,
  embedding         extensions.vector(1024),
  criado_em         timestamptz not null default now()
);
create index knowledge_chunks_doctor_idx on public.knowledge_chunks (doctor_id);

-- ---------------------------------------------------------------------
-- campanhas  [C: doctor_id, nome, mensagem, filtro_status, total_leads,
--   status, enviados, pendentes_template, enviado_em, criado_em]
-- (migration 0006 adiciona `processando_desde`)
-- ---------------------------------------------------------------------
create table public.campanhas (
  id                 uuid primary key default gen_random_uuid(),
  doctor_id          uuid not null references public.doctors(id) on delete cascade,  -- [C]
  nome               text,   -- [C]
  mensagem           text,   -- [C]
  filtro_status      text,   -- [C]
  total_leads        integer not null default 0,  -- [C]
  status             text not null default 'rascunho',  -- [C]
  enviados           integer,   -- [C]
  pendentes_template integer,   -- [C]
  enviado_em         timestamptz,  -- [C]
  criado_em          timestamptz not null default now()  -- [C]
);

-- ---------------------------------------------------------------------
-- transactions  [C: deal_id, gateway, gateway_transaction_id, valor, status,
--   metodo_pagamento] + upsert onConflict (gateway, gateway_transaction_id)
-- ---------------------------------------------------------------------
create table public.transactions (
  id                     uuid primary key default gen_random_uuid(),
  deal_id                uuid references public.deals(id) on delete set null,  -- [C]
  gateway                text not null,  -- [C]
  gateway_transaction_id text not null,  -- [C]
  valor                  numeric(14,2), -- [C]
  status                 text,          -- [C]
  metodo_pagamento       text,          -- [C]
  criado_em              timestamptz not null default now(),  -- [C: order('criado_em')]
  unique (gateway, gateway_transaction_id)  -- [C]
);

-- ---------------------------------------------------------------------
-- ia_agentes_bdr  [A: migration 0002 do repo]
-- ---------------------------------------------------------------------
create table public.ia_agentes_bdr (
  id        uuid primary key default gen_random_uuid(),
  doctor_id uuid not null unique references public.doctors(id) on delete cascade,
  nome      text not null default 'BDR',
  contexto  text,
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Funções auxiliares (SECURITY DEFINER, SQL) — reproduzidas FIELMENTE da FASE 0.
-- (Sem `set search_path` — igual produção. A revisão adversarial da ETAPA 7
--  registra isso como achado real de produção.)
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
as $$
  select exists(select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_doctor_owner(target_doctor_id uuid)
returns boolean
language sql
security definer
as $$
  select exists(
    select 1 from public.doctors
    where id = target_doctor_id and owner_user_id = auth.uid()
  );
$$;

create or replace function public.user_has_doctor_access(target_doctor_id uuid)
returns boolean
language sql
security definer
as $$
  select exists(
    select 1 from public.user_doctor_access
    where doctor_id = target_doctor_id and user_id = auth.uid()
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_doctor_owner(uuid) to anon, authenticated;
grant execute on function public.user_has_doctor_access(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- RLS — habilitada em TODAS as tabelas de negócio.
-- ---------------------------------------------------------------------
alter table public.users               enable row level security;
alter table public.doctors             enable row level security;
alter table public.user_doctor_access  enable row level security;
alter table public.products            enable row level security;
alter table public.leads               enable row level security;
alter table public.deals               enable row level security;
alter table public.conversations       enable row level security;
alter table public.events              enable row level security;
alter table public.atendimentos        enable row level security;
alter table public.integrations        enable row level security;
alter table public.google_tokens       enable row level security;
alter table public.knowledge_base      enable row level security;
alter table public.knowledge_chunks    enable row level security;
alter table public.campanhas           enable row level security;
alter table public.transactions        enable row level security;
alter table public.ia_agentes_bdr      enable row level security;

-- ---------------------------------------------------------------------
-- Policies — texto EXATO capturado na FASE 0 (00-current-state-audit.md §2.4,
-- pg_policies). Role `public` (anon + authenticated). Tabelas sem policy
-- ficam deny-all para esses papéis (só service_role passa).
-- ---------------------------------------------------------------------

-- users
create policy self_read_users on public.users
  for select using (id = auth.uid());
create policy doctor_reads_own_closers on public.users
  for select using (exists (
    select 1 from public.user_doctor_access uda
    join public.doctors d on d.id = uda.doctor_id
    where uda.user_id = users.id and d.owner_user_id = auth.uid()
  ));

-- doctors
create policy admin_full_access_doctors on public.doctors
  for all using (public.is_admin());
create policy closer_scoped_doctors on public.doctors
  for select using (public.user_has_doctor_access(id));
create policy doctor_owns_own_row on public.doctors
  for all using (owner_user_id = auth.uid());

-- user_doctor_access
create policy own_membership_read on public.user_doctor_access
  for select using (user_id = auth.uid());
create policy doctor_reads_own_team_links on public.user_doctor_access
  for select using (public.is_doctor_owner(doctor_id));

-- leads
create policy admin_full_access_leads on public.leads
  for all using (public.is_admin());
create policy doctor_scoped_leads on public.leads
  for all using (exists (
    select 1 from public.doctors d where d.id = leads.doctor_id and d.owner_user_id = auth.uid()
  ));
create policy closer_scoped_leads on public.leads
  for select using (exists (
    select 1 from public.user_doctor_access uda
    where uda.doctor_id = leads.doctor_id and uda.user_id = auth.uid()
  ));
create policy closer_updates_own_leads on public.leads
  for update using (sdr_responsavel_id = auth.uid());

-- events
create policy admin_full_access_events on public.events
  for all using (public.is_admin());
create policy doctor_scoped_events on public.events
  for all using (exists (
    select 1 from public.doctors d where d.id = events.doctor_id and d.owner_user_id = auth.uid()
  ));
create policy closer_scoped_events on public.events
  for all using (responsavel_id = auth.uid());

-- atendimentos
create policy admin_full_access_atendimentos on public.atendimentos
  for all using (public.is_admin());
create policy doctor_scoped_atendimentos on public.atendimentos
  for all using (exists (
    select 1 from public.leads l
    join public.doctors d on d.id = l.doctor_id
    where l.id = atendimentos.lead_id and d.owner_user_id = auth.uid()
  ));

-- google_tokens
create policy admin_full_access_google_tokens on public.google_tokens
  for all using (public.is_admin());
create policy self_manage_google_tokens on public.google_tokens
  for all using (user_id = auth.uid());

-- integrations
create policy admin_full_access_integrations on public.integrations
  for all using (public.is_admin());
create policy doctor_manages_own_integrations on public.integrations
  for all using (exists (
    select 1 from public.doctors d where d.id = integrations.doctor_id and d.owner_user_id = auth.uid()
  ));

-- knowledge_base  (policy INSEGURA original — migration 0003 a remove)
create policy service_role_all_knowledge_base on public.knowledge_base
  for all using (true) with check (true);

-- campanhas  (policy INSEGURA original — migration 0003 a remove)
create policy service_role_all_campanhas on public.campanhas
  for all using (true) with check (true);

-- Tabelas SEM policy (deny-all a anon/authenticated): products, deals,
-- conversations, transactions, knowledge_chunks, ia_agentes_bdr.
