-- Seed SINTÉTICO para testes de RLS locais. NENHUM dado real.
-- Aplicado só num Supabase LOCAL (supabase db reset).
-- Reflete o schema ATUAL (modelo doctor_id) — não o modelo-alvo multitenant.
--
-- Os testes de RLS setam `request.jwt.claims` com estes UUIDs como `sub`;
-- `auth.uid()` lê isso do JWT e NÃO consulta auth.users — por isso o seed
-- não precisa criar linhas em auth.users.
--
-- Todos os UUIDs são hex-válidos. Sufixos (últimos 12 chars):
--   00000000a001 A_OWNER    00000000b001 B_OWNER
--   00000000ac01 A_CLOSER   00000000ad01 PLAT_ADMIN   00000000dead NOBODY
--   0000000000da doctor A   0000000000db doctor B
--   0000000001a1/01a2 lead A | 0000000001b1 lead B
--   00000000021a/021b products | 0000000031a/031b deals | 0000000041a/041b events
--   0000000051a/051b conversas | 0000000061a/061b integrations
--   0000000071a/071b campanhas | 0000000081a/081b knowledge_base
--
-- Cenário: Org A = doctor DA (owner A_OWNER); Org B = doctor DB (owner B_OWNER);
--          A_CLOSER tem acesso à Org A; PLAT_ADMIN = users.role 'admin'.

insert into public.users (id, nome, email, role, ativo) values
  ('00000000-0000-4000-8000-00000000a001', 'Dona da Org A',    'a-owner@local.test',   'doctor', true),
  ('00000000-0000-4000-8000-00000000b001', 'Dono da Org B',    'b-owner@local.test',   'doctor', true),
  ('00000000-0000-4000-8000-00000000ac01', 'Closer da Org A',  'a-closer@local.test',  'closer', true),
  ('00000000-0000-4000-8000-00000000ad01', 'Admin Plataforma', 'plat-admin@local.test','admin',  true),
  -- closer ligado às DUAS clínicas -> após backfill 0008: 2 memberships (2 orgs)
  ('00000000-0000-4000-8000-0000000000c2', 'Closer Multi',     'multi@local.test',     'closer', true),
  -- closer legado SEM user_doctor_access -> backfill registra 'closer_without_access'
  ('00000000-0000-4000-8000-0000000000c3', 'Closer Orfao',     'orfao@local.test',     'closer', true);

insert into public.doctors (id, owner_user_id, nome, status, plano) values
  ('00000000-0000-4000-8000-0000000000da', '00000000-0000-4000-8000-00000000a001', 'Clínica A', 'ativo', 'gratuito'),
  ('00000000-0000-4000-8000-0000000000db', '00000000-0000-4000-8000-00000000b001', 'Clínica B', 'ativo', 'gratuito');

insert into public.user_doctor_access (user_id, doctor_id) values
  ('00000000-0000-4000-8000-00000000ac01', '00000000-0000-4000-8000-0000000000da'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000da'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000db');

insert into public.products (id, doctor_id, nome, preco) values
  ('00000000-0000-4000-8000-00000000021a', '00000000-0000-4000-8000-0000000000da', 'Produto A', 100),
  ('00000000-0000-4000-8000-00000000021b', '00000000-0000-4000-8000-0000000000db', 'Produto B', 200);

insert into public.leads (id, doctor_id, nome, telefone, status_atual, journey_type, sdr_responsavel_id) values
  ('00000000-0000-4000-8000-0000000001a1', '00000000-0000-4000-8000-0000000000da', 'Lead A1', '5544900000001', 'lead', 'low_ticket', '00000000-0000-4000-8000-00000000ac01'),
  ('00000000-0000-4000-8000-0000000001a2', '00000000-0000-4000-8000-0000000000da', 'Lead A2', '5544900000003', 'lead', 'low_ticket', null),
  ('00000000-0000-4000-8000-0000000001b1', '00000000-0000-4000-8000-0000000000db', 'Lead B1', '5544900000002', 'lead', 'low_ticket', null);

insert into public.deals (id, lead_id, etapa, sdr_responsavel_id) values
  ('00000000-0000-4000-8000-00000000031a', '00000000-0000-4000-8000-0000000001a1', 'lead', '00000000-0000-4000-8000-00000000ac01'),
  ('00000000-0000-4000-8000-00000000031b', '00000000-0000-4000-8000-0000000001b1', 'lead', null);

insert into public.events (id, doctor_id, lead_id, tipo, titulo, inicio, responsavel_id, status) values
  ('00000000-0000-4000-8000-00000000041a', '00000000-0000-4000-8000-0000000000da', '00000000-0000-4000-8000-0000000001a1', 'reuniao', 'Ev A', now(), '00000000-0000-4000-8000-00000000ac01', 'pendente'),
  ('00000000-0000-4000-8000-00000000041b', '00000000-0000-4000-8000-0000000000db', '00000000-0000-4000-8000-0000000001b1', 'reuniao', 'Ev B', now(), '00000000-0000-4000-8000-00000000b001', 'pendente');

insert into public.conversations (id, lead_id, canal, direcao, conteudo, origem) values
  ('00000000-0000-4000-8000-00000000051a', '00000000-0000-4000-8000-0000000001a1', 'whatsapp', 'recebida', 'oi A', 'automatico'),
  ('00000000-0000-4000-8000-00000000051b', '00000000-0000-4000-8000-0000000001b1', 'whatsapp', 'recebida', 'oi B', 'automatico');

insert into public.integrations (id, doctor_id, gateway, external_id, access_token, webhook_token) values
  ('00000000-0000-4000-8000-00000000061a', '00000000-0000-4000-8000-0000000000da', 'whatsapp', 'pn-A', 'segredo-A', 'wht-A'),
  ('00000000-0000-4000-8000-00000000061b', '00000000-0000-4000-8000-0000000000db', 'whatsapp', 'pn-B', 'segredo-B', 'wht-B');

insert into public.google_tokens (user_id, refresh_token, access_token) values
  ('00000000-0000-4000-8000-00000000a001', 'gr-A', 'ga-A'),
  ('00000000-0000-4000-8000-00000000b001', 'gr-B', 'ga-B');

insert into public.campanhas (id, doctor_id, nome, mensagem) values
  ('00000000-0000-4000-8000-00000000071a', '00000000-0000-4000-8000-0000000000da', 'Camp A', 'Ola A'),
  ('00000000-0000-4000-8000-00000000071b', '00000000-0000-4000-8000-0000000000db', 'Camp B', 'Ola B');

insert into public.knowledge_base (id, doctor_id, titulo, conteudo) values
  ('00000000-0000-4000-8000-00000000081a', '00000000-0000-4000-8000-0000000000da', 'FAQ A', 'Conteudo interno A'),
  ('00000000-0000-4000-8000-00000000081b', '00000000-0000-4000-8000-0000000000db', 'FAQ B', 'Conteudo interno B');

-- FASE 2.3: dados sintéticos dos módulos expandidos (sufixos hex de 12 chars).
--   knowledge_chunks 00000000091a/091b | ia_agentes_bdr 0000000a0a1a/0a1b
--   atendimentos 0000000b0b1a/0b1b     | transactions 0000000c0c1a/0c1b
insert into public.knowledge_chunks (id, knowledge_base_id, doctor_id, titulo, conteudo, chunk_index) values
  ('00000000-0000-4000-8000-00000000091a', '00000000-0000-4000-8000-00000000081a', '00000000-0000-4000-8000-0000000000da', 'Chunk A', 'trecho interno A', 0),
  ('00000000-0000-4000-8000-00000000091b', '00000000-0000-4000-8000-00000000081b', '00000000-0000-4000-8000-0000000000db', 'Chunk B', 'trecho interno B', 0);

insert into public.ia_agentes_bdr (id, doctor_id, nome, contexto) values
  ('00000000-0000-4000-8000-0000000a0a1a', '00000000-0000-4000-8000-0000000000da', 'BDR A', 'contexto BDR A'),
  ('00000000-0000-4000-8000-0000000a0a1b', '00000000-0000-4000-8000-0000000000db', 'BDR B', 'contexto BDR B');

insert into public.atendimentos (id, lead_id, event_id, data, valor, compareceu) values
  ('00000000-0000-4000-8000-0000000b0b1a', '00000000-0000-4000-8000-0000000001a1', '00000000-0000-4000-8000-00000000041a', now(), 500, true),
  ('00000000-0000-4000-8000-0000000b0b1b', '00000000-0000-4000-8000-0000000001b1', '00000000-0000-4000-8000-00000000041b', now(), 700, true);

insert into public.transactions (id, deal_id, gateway, gateway_transaction_id, valor, status, metodo_pagamento) values
  ('00000000-0000-4000-8000-0000000c0c1a', '00000000-0000-4000-8000-00000000031a', 'pagarme', 'tx-A-1', 500, 'pago', 'pix'),
  ('00000000-0000-4000-8000-0000000c0c1b', '00000000-0000-4000-8000-00000000031b', 'pagarme', 'tx-B-1', 700, 'pago', 'pix');

-- FASE 2.1/2.3: re-executa os backfills de tenancy AGORA que doctors/users existem
-- (migrations rodam antes do seed; as funções são idempotentes).
select public.backfill_tenant_core();
select public.backfill_tenant_expansion();
