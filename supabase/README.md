# Supabase local — desenvolvimento e testes de RLS

> **Nada aqui é executado automaticamente.** Comandos documentados; rodar
> manualmente, com Docker, quando autorizado. NÃO conecta ao Supabase real.

## Pré-requisitos

- Docker Desktop instalado e rodando (para `supabase start`).
- Supabase CLI — **sem instalação global**, via `npx`:
  ```bash
  npx supabase@latest --version
  ```

## Estrutura

```
supabase/
  config.toml            # portas e config do stack local
  seed.sql               # dados SINTÉTICOS (2 orgs, users, memberships, leads)
  migrations/            # migrations no formato do CLI (ver migrations/README.md)
```

As migrations de produto vivem hoje em `../migrations/` (`0003`–`0006`). Para o
CLI, elas precisam estar em `supabase/migrations/` com nome
`<YYYYMMDDHHMMSS>_nome.sql`. Ver `supabase/migrations/README.md`.

## Comandos (rodar manualmente)

```bash
# 1. Sobe o stack local (Postgres + Auth + Studio + Inbucket) — precisa de Docker
npx supabase start

# 2. Gera o baseline do schema atual A PARTIR DE UM DUMP (nunca do projeto real):
#    - obtenha um dump do schema (sem dados) de um ambiente NÃO-produção
#    - salve como supabase/migrations/00000000000000_baseline.sql
#    (Alternativa: recriar o schema base manualmente num script de baseline.)

# 3. Aplica todas as migrations + o seed sintético
npx supabase db reset            # dropa, recria, roda migrations + seed.sql

# 4. Testes de integração de RLS (contra o Postgres local)
SUPABASE_TEST_DB_URL="postgresql://postgres:postgres@localhost:54322/postgres" \
  npx vitest run test/rls

# 5. Derruba o stack
npx supabase stop
```

## Regras

- **Seed é 100% sintético.** Nunca importar dados de produção.
- **Sem `supabase link`** a um projeto remoto nesta fase.
- **Sem `supabase db push`** para um projeto remoto.
- As travas de boot do backend (`src/config/env.js`) impedem o servidor de subir
  contra `SUPABASE_URL` de produção fora de `APP_ENV=production`.

## Testes de RLS

`test/rls/` contém testes de integração que abrem conexões Postgres como os
papéis `anon` e `authenticated` (via `SET request.jwt.claims`) e verificam:

| Caso | Esperado |
| --- | --- |
| `anon` lê qualquer tabela de negócio | **negado** / 0 linhas |
| `authenticated` sem membership | **0 linhas** em `leads`, `doctors`, etc. |
| closer da Org A lê `leads` da Org B | **0 linhas** |
| doctor da Org A lê só os próprios `leads`/`doctors` | vê Org A, não vê Org B |
| admin de plataforma (`users.role='admin'`) | vê tudo — conforme `is_admin()` |
| `anon`/`authenticated` em `campanhas`/`knowledge_base` **após migration 0003** | **negado** (lockdown R01) |

Os testes **pulam automaticamente** (`describe.skip`) se `SUPABASE_TEST_DB_URL`
não estiver definida — assim `npm test` normal não depende de Docker.
