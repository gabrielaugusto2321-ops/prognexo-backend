-- Base de conhecimento com busca vetorial (RAG)
-- ------------------------------------------------------------------
-- Substitui a v1 (concatenar todo o texto ativo no prompt) por busca
-- por similaridade: cada item da knowledge_base é dividido em chunks,
-- cada chunk ganha um embedding (Voyage AI, voyage-3.5-lite, 1024 dims)
-- e na hora de responder o lead a gente embeda a pergunta e busca só
-- os trechos mais parecidos.
--
-- REVISAR antes de aplicar no Supabase de produção.

-- 1. Extensão pgvector (disponível no Supabase, só não estava habilitada)
create extension if not exists vector with schema extensions;

-- 2. Tabela de chunks
create table if not exists public.knowledge_chunks (
  id                uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references public.knowledge_base(id) on delete cascade,
  doctor_id         uuid not null references public.doctors(id) on delete cascade,
  titulo            text,
  conteudo          text not null,
  chunk_index       integer not null default 0,
  embedding         extensions.vector(1024) not null,
  criado_em         timestamptz not null default now()
);

create index if not exists knowledge_chunks_doctor_id_idx
  on public.knowledge_chunks (doctor_id);

create index if not exists knowledge_chunks_kb_id_idx
  on public.knowledge_chunks (knowledge_base_id);

-- Índice de similaridade por cosseno (HNSW: bom recall, sem precisar
-- popular antes como o ivfflat).
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- Segue o padrão das outras tabelas: RLS ligada, sem policies — o
-- backend usa a service role key e faz o controle de acesso por
-- doctor_id na aplicação.
alter table public.knowledge_chunks enable row level security;

-- 3. RPC de busca por similaridade
-- Já filtra pelo médico e só considera itens ativos da knowledge_base.
-- similarity = 1 - distância_cosseno  (1.0 = idêntico, 0.0 = ortogonal)
create or replace function public.match_knowledge_chunks (
  query_embedding extensions.vector(1024),
  p_doctor_id     uuid,
  match_threshold double precision default 0.4,
  match_count     integer default 6
)
returns table (
  id                uuid,
  knowledge_base_id uuid,
  titulo            text,
  conteudo          text,
  similarity        double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select
    kc.id,
    kc.knowledge_base_id,
    kc.titulo,
    kc.conteudo,
    1 - (kc.embedding <=> query_embedding) as similarity
  from public.knowledge_chunks kc
  join public.knowledge_base kb on kb.id = kc.knowledge_base_id
  where kb.ativo = true
    and kc.doctor_id = p_doctor_id
    and 1 - (kc.embedding <=> query_embedding) >= match_threshold
  order by kc.embedding <=> query_embedding asc
  limit match_count
$$;
