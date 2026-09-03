# 15 — Auditoria de deploy e push (FASE 1B.1)

Inspeção **somente leitura** dos dois repositórios (`prognexo-backend`, `prognexo-frontend`),
branch `foundation/staging-and-operations`. **Nenhum push realizado.**

## 1. O que existe versionado

| Item | prognexo-backend | prognexo-frontend |
| --- | --- | --- |
| `.github/` (Actions/workflows) | **ausente** | **ausente** |
| `vercel.json` / `.vercelignore` | ausente | ausente |
| `render.yaml` / `render.json` | ausente | ausente |
| `railway.json` / `railway.toml` / `nixpacks.toml` | ausente | ausente |
| `netlify.toml` | ausente | ausente |
| `fly.toml` | ausente | ausente |
| `Dockerfile` / `docker-compose.yml` / `.dockerignore` | ausente | ausente |
| `Procfile` | ausente | ausente |
| `.circleci/` / `.gitlab-ci.yml` / Jenkins | ausente | ausente |
| git hooks versionados (`.githooks/`) | ausente | ausente |
| git hooks locais ativos (`.git/hooks/*` não-sample) | nenhum | nenhum |
| remotes | só `origin` (GitHub) | só `origin` (GitHub) |
| scripts de deploy em `package.json` | nenhum | nenhum |

**Nenhuma configuração de deploy está no repositório.** A publicação é controlada
**fora do git**, no painel do provedor (integração Git do Vercel/host).

## 2. Sinais indiretos de hospedagem

- Frontend: `prognexo-frontend.vercel.app` aparece hardcoded como fallback em
  `src/routes/googleAuth.js` e `src/routes/planos.js` do backend → **frontend hospedado na Vercel** (integração Git pelo dashboard).
- Backend: servidor Express (`src/server.js`, `app.listen`). Não é serverless nativo da Vercel.
  Sem arquivo de config → host provável Render/Railway/VPS, também configurado pelo dashboard. **Não confirmável só pelo repo.**
- `VITE_API_URL` (frontend) e `FRONTEND_URL` (backend) ligam os dois por variável de ambiente.

## 3. Matriz de auto-deploy

| Serviço | Arquivo/config | Branch que dispara | Push da branch `foundation/staging-and-operations` faria deploy? | Risco | Ação recomendada |
| --- | --- | --- | --- | --- | --- |
| **Vercel — frontend** | nenhum no repo; integração Git no dashboard | **Production**: branch de produção (normalmente `main`). **Preview**: **qualquer branch** por padrão | **Provavelmente SIM — um Preview Deployment** (não produção), a menos que "Preview Deployments" esteja restrito a branches específicas nas Project Settings | Médio — preview expõe uma URL pública com o código não revisado; **não** afeta produção; pode consumir build minutes; pode disparar comentários em PR | Antes de qualquer push: no dashboard Vercel → Settings → Git → **desabilitar Preview Deployments** ou restringir a uma allowlist; confirmar que a Production Branch é `main` |
| **Host do backend (Render/Railway/etc.)** | nenhum no repo; dashboard | Depende do painel: normalmente **só a branch conectada** (ex.: `main`); alguns habilitam PR/preview environments | **Provavelmente NÃO** se conectado só a `main`; **SIM** se "deploy on any branch" / PR previews estiver ligado | Alto se ligado — publicaria um backend com código não revisado, potencialmente apontando para o Supabase de produção | Confirmar no painel do host: branch conectada = `main`; PR/preview environments **desligados**; nenhuma auto-deploy de branch arbitrária |
| **Supabase** | migrations locais (`migrations/`, `supabase/migrations/`) | N/A — nenhuma automação de migration está configurada | **NÃO** — migrations só são aplicadas manualmente (`migrations/README.md`) | Baixo | Manter aplicação manual; nunca ligar auto-migration em push |
| **GitHub Actions** | inexistente | N/A | **NÃO** | Nenhum | Ao adicionar CI (recomendado), usar `on: pull_request` + `on: push: branches: [main]` apenas; nunca `on: push` sem filtro de branch |
| **Git hooks** | inexistentes | N/A | **NÃO** | Nenhum | — |

## 4. Conclusão para a FASE 1B.1

- **Nesta fase não haverá push** — o risco é apenas teórico.
- O único caminho de auto-deploy plausível de um push desta branch é um **Preview Deployment do frontend na Vercel** (URL pública, sem impacto em produção).
- **Antes de qualquer push futuro de branch que não seja `main`**, executar o checklist de §3 (coluna "Ação recomendada") nos painéis da Vercel e do host do backend.
- Recomendação de médio prazo: **adotar configuração de deploy versionada** (`vercel.json` com `git.deploymentEnabled` por branch; CI com filtro de branch explícito) para que a política de publicação seja auditável no repositório, não só no dashboard.
