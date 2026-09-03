# 16 — Análise de dependências e vulnerabilidades (FASE 1B.1)

`npm audit fix` **sem `--force`** foi executado nos dois repositórios:
- **backend**: no-op (nenhuma mudança em `package.json` ou `package-lock.json`).
- **frontend**: bumparia `react-router 6.30.4 → 6.30.6` (patch dentro de `^6`), mas **não fecha o advisory** (que cobre `6.0.0 – 7.17.0`) → revertido para manter o diff da FASE 1B.1 sem mudança de dependência não comprovadamente corretiva.

**Nenhum upgrade breaking foi aplicado. `--force` não foi usado.**

## Backend

### `qs` (moderate ×2)
- **Advisories**: `GHSA-x5fp-wj9c-mxmx` (array-limit bypass), `GHSA-4mjr-xmp4-gh2g` (DoS via isBuffer).
- **Caminho**: `express@4.22.2 → body-parser@1.20.6 → qs@6.15.3`; também via `googleapis-common` e `superagent` (devDep de teste).
- **Exposição real no Prognexo**: **baixa** — o parsing de query só ocorre em rotas GET; nenhuma rota depende de arrays profundos em query string; `express.json({ limit: '100kb' })` limita o corpo; há rate-limit e WAF previsto. O DoS exige controle do `Content-Type`/estrutura e volume — mitigado por rate-limit.
- **Versão corrigida**: `qs@6.16.0`. O range do `express@4.x`/`body-parser@1.x` ainda não a permite (`npm outdated` → `Wanted: 6.15.3` nesse caminho).
- **Breaking**: o fix "oficial" do audit é `express@5` (**major, breaking** — mudanças em rotas, middleware, `req`/`res`).
- **Testes necessários se atualizar**: suíte completa + smoke de todas as rotas (express 5 muda `app.use` path matching, `res.redirect`, query parser default).
- **Recomendação**: **adiar**. Reavaliar quando `body-parser@1.20.7`/`express@4.x` liberarem `qs@6.16`. Não migrar para express 5 nesta fase. Mitigação já ativa: `limit` de corpo + rate-limit.

### `uuid` via `googleapis` (moderate)
- **Advisory**: `GHSA-w5hq-g745-h8pq` — `uuid` v3/v5/v6 sem bounds check quando `buf` é passado.
- **Caminho**: `googleapis@144 → googleapis-common / gaxios → uuid@9.0.1`.
- **Exposição real**: **muito baixa** — o Prognexo não chama `uuid` diretamente; o `googleapis` usa `uuid` para gerar IDs de request (sem `buf` fornecido, o vetor não se aplica). Só entra em cena no fluxo do Google Calendar, que é opcional e por-usuário.
- **Versão corrigida**: `uuid@11.1.1+`. Só chega via `googleapis@178` (**major, breaking** — mudanças de API do cliente Google).
- **Testes necessários se atualizar**: `test/oauth-google*.test.js` + smoke real do fluxo Calendar (connect → callback → criar evento → freebusy) num ambiente de dev.
- **Recomendação**: **isolar + adiar**. Isolar: o código do Google já está contido em `src/lib/googleCalendar.js` e `src/routes/googleAuth.js`, e falha graciosamente (`criarEventoNoGoogle` retorna `null`). Agendar o bump de `googleapis` para uma tarefa dedicada com teste de fumaça manual.

## Frontend

### `react-router` / `react-router-dom` (moderate ×2)
- **Advisories**: `GHSA-wrjc-x8rr-h8h6` (open redirect via backslash em `<Link>`/`useNavigate`, bypass do CVE-2025-68470), `GHSA-337j-9hxr-rhxg` (constructor injection via `deserializeErrors()` na hidratação SSR).
- **Caminho**: `prognexo-frontend → react-router-dom@6.30.4 → react-router@6.30.4`.
- **Exposição real no Prognexo**:
  - Open redirect: **baixa** — o app usa `HashRouter`; `navigate()` é chamado só com paths internos literais (`/login`, `/`, `/agenda`); não há `navigate(userControlledValue)`. Ainda assim, a correção de OAuth (R06) e o padrão de allowlist reduzem o impacto de um redirect.
  - `deserializeErrors()` SSR: **não aplicável** — o frontend é SPA client-side (Vite), sem SSR/hidratação do React Router.
- **Versão corrigida**: o advisory cobre `6.0.0 – 7.17.0`; o fix real é `react-router-dom@7.18.3` (**major, breaking** — API de rotas do v7, `createBrowserRouter`, loaders/actions, mudança de `<Routes>`).
- **Testes necessários se atualizar**: reescrever `src/App.jsx` (roteamento), testar todas as telas e o fluxo de convite/`type=invite`/`type=recovery` no hash; build + navegação manual.
- **Recomendação**: **adiar com mitigação**. Mitigação já presente: `HashRouter` + navegação só com paths literais + R06. Agendar a migração para React Router 7 como tarefa própria (impacto em `App.jsx` e em todas as `<Route>`), com aprovação.

### `vite` / `esbuild` (1 high + 1 moderate)
- **Advisories**: path traversal em optimized deps (`.map`), `server.fs.deny` bypass no Windows, esbuild dev-server aberto a qualquer site.
- **Caminho**: `prognexo-frontend → vite@5.4.x → esbuild@0.21.x`.
- **Exposição real**: **nula em produção** — `vite` e `esbuild` são **devDependencies**; só rodam no `vite dev` (servidor de desenvolvimento local) e no `vite build`. O artefato de produção é estático (`dist/`), sem `vite`/`esbuild` em runtime. Os vetores exigem que um atacante alcance o **dev server** do desenvolvedor.
- **Versão corrigida**: `vite@8` (**major, breaking** — Node 20+, mudanças de config, plugins).
- **Recomendação**: **adiar** (é dev-only, zero exposição em produção). Mitigação: rodar `vite dev` só em `localhost`, nunca expor a porta. Agendar `vite@6/7/8` numa tarefa de tooling.

## Resumo — recomendações

| Dependência | Repo | Severidade | Exposição real | Ação FASE 1B.1 | Quando |
| --- | --- | --- | --- | --- | --- |
| `qs` | backend | moderate | baixa | **adiar** | quando `express@4.x` liberar `qs@6.16`; senão avaliar express@5 |
| `uuid` (via googleapis) | backend | moderate | muito baixa | **isolar + adiar** | tarefa dedicada: bump `googleapis@178` + smoke do Calendar |
| `react-router` | frontend | moderate | baixa (`HashRouter`, paths literais, SPA) | **adiar + mitigar** | tarefa dedicada: migração para React Router 7 |
| `vite`/`esbuild` | frontend | high + moderate | **nula em prod** (devDep) | **adiar** | tarefa de tooling: `vite@8` |

**Nenhuma exige ação bloqueante para a FASE 1B.1.** `npm audit fix` sem `--force` não muda nada de forma segura. Toda correção pendente é um upgrade **breaking** que precisa de aprovação e de uma tarefa própria com testes.
