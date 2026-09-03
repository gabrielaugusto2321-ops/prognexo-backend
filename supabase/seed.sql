-- Seed SINTÉTICO para desenvolvimento e testes de RLS locais.
-- NENHUM dado real. Aplicado só num Supabase LOCAL (supabase db reset).
-- Reflete o schema ATUAL (modelo doctor_id) — não o modelo-alvo multitenant.
--
-- Cenário:
--   Organização A  = doctor 'aaaa...' (owner = user 'a-owner')
--   Organização B  = doctor 'bbbb...' (owner = user 'b-owner')
--   closer 'a-closer' tem acesso à Org A (user_doctor_access)
--   admin de plataforma = user 'plat-admin' (users.role = 'admin')
--
-- Os usuários de auth precisam existir em auth.users com esses ids para os
-- testes de RLS (auth.uid()). Criados abaixo com senha fake.

-- ---- auth.users (senha: 'local-dev-password-123' — hash não importa para testes de RLS) ----
insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role)
values
  ('00000000-0000-4000-8000-00000000a001', 'a-owner@local.test',  crypt('local-dev-password-123', gen_salt('bf')), now(), 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-00000000b001', 'b-owner@local.test',  crypt('local-dev-password-123', gen_salt('bf')), now(), 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000ac001', 'a-closer@local.test', crypt('local-dev-password-123', gen_salt('bf')), now(), 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-00000plat001', 'plat-admin@local.test',crypt('local-dev-password-123', gen_salt('bf')), now(), 'authenticated', 'authenticated')
on conflict (id) do nothing;

-- ---- public.users ----
insert into public.users (id, nome, email, role, ativo) values
  ('00000000-0000-4000-8000-00000000a001', 'Dona da Org A',  'a-owner@local.test',  'doctor', true),
  ('00000000-0000-4000-8000-00000000b001', 'Dono da Org B',  'b-owner@local.test',  'doctor', true),
  ('00000000-0000-4000-8000-0000000ac001', 'Closer da Org A', 'a-closer@local.test', 'closer', true),
  ('00000000-0000-4000-8000-00000plat001', 'Admin Plataforma','plat-admin@local.test','admin', true)
on conflict (id) do nothing;

-- ---- public.doctors (tenants) ----
insert into public.doctors (id, owner_user_id, nome, status, plano) values
  ('00000000-0000-4000-8000-0000000da001', '00000000-0000-4000-8000-00000000a001', 'Clínica A', 'ativo', 'gratuito'),
  ('00000000-0000-4000-8000-0000000db001', '00000000-0000-4000-8000-00000000b001', 'Clínica B', 'ativo', 'gratuito')
on conflict (id) do nothing;

-- ---- public.user_doctor_access (closer -> Org A) ----
insert into public.user_doctor_access (user_id, doctor_id) values
  ('00000000-0000-4000-8000-0000000ac001', '00000000-0000-4000-8000-0000000da001')
on conflict do nothing;

-- ---- leads sintéticos ----
insert into public.leads (id, doctor_id, nome, telefone, status_atual, journey_type, sdr_responsavel_id) values
  ('00000000-0000-4000-8000-0000000la001', '00000000-0000-4000-8000-0000000da001', 'Lead A1', '5544900000001', 'lead', 'low_ticket', '00000000-0000-4000-8000-0000000ac001'),
  ('00000000-0000-4000-8000-0000000lb001', '00000000-0000-4000-8000-0000000db001', 'Lead B1', '5544900000002', 'lead', 'low_ticket', null)
on conflict (id) do nothing;

-- ---- campanha e item de base de conhecimento (para provar o lockdown R01) ----
insert into public.campanhas (id, doctor_id, nome, mensagem) values
  ('00000000-0000-4000-8000-0000000ca001', '00000000-0000-4000-8000-0000000da001', 'Campanha A', 'Olá!')
on conflict (id) do nothing;

insert into public.knowledge_base (id, doctor_id, titulo, conteudo) values
  ('00000000-0000-4000-8000-0000000kb001', '00000000-0000-4000-8000-0000000da001', 'FAQ A', 'Conteúdo interno da Clínica A')
on conflict (id) do nothing;
