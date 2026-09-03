# 14 — Ambientes (development / test / staging / production)

FASE 1B.1. Nenhum recurso externo criado — só configuração local, exemplos e travas de boot.

## 1. Os quatro ambientes

| Ambiente | `NODE_ENV` | `APP_ENV` | Supabase | Meta / Google | Pagamentos | Dados |
| --- | --- | --- | --- | --- | --- | --- |
| **development** | `development` | `development` | projeto local (Supabase CLI) ou de dev dedicado | app de dev | sandbox/off | **sintéticos** |
| **test** | `test` | `test` | nenhum (mocks) ou local efêmero | nenhum (mocks) | off | **sintéticos** |
| **staging** | `production` | `staging` | projeto Supabase de **staging** (separado) | app de **staging/dev** | sandbox/off | **sintéticos** ou export mascarado |
| **production** | `production` | `production` | projeto de produção | app de produção (em análise pela Meta) | conforme contrato | reais |

`APP_ENV` é o ambiente **lógico**; `NODE_ENV` continua sendo o modo de runtime do Node (staging e production rodam com `NODE_ENV=production` para o comportamento de libs). Se `APP_ENV` for omitido, é derivado de `NODE_ENV`.

## 2. Variáveis obrigatórias por ambiente

Validação em `src/config/env.js` (`validateEnv`), executada no import — **derruba o boot** se algo faltar.

| Variável | dev | test | staging | production |
| --- | --- | --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | recomendado | — (mock) | **obrigatório** | **obrigatório** |
| `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` | recomendado | — | **obrigatório** | **obrigatório** |
| `META_APP_SECRET`, `META_SYSTEM_USER_TOKEN`, `WHATSAPP_VERIFY_TOKEN` | opcional | — | **obrigatório** | **obrigatório** |
| `CRON_SECRET` | opcional | — | **obrigatório** | **obrigatório** |
| `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS` | recomendado | opcional | **obrigatório** | **obrigatório** |
| `CAPTCHA_ENABLED=true` + `CAPTCHA_SECRET` | opcional | — | **obrigatório** | **obrigatório** |
| `PAGARME/KIWIFY/HOTMART` secrets | — | — | só se `PAYMENT_WEBHOOKS_ENABLED=true` | só se `PAYMENT_WEBHOOKS_ENABLED=true` |
| `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` | opcional | — (mock) | recomendado | recomendado |
| `PRODUCTION_HOSTS` | recomendado | — | **recomendado** | opcional |
| `APP_INSTANCE_COUNT` | — | — | recomendado | **recomendado** |

## 3. Travas de boot — combinações perigosas

`validateEnv` lança `Dangerous environment configuration` e o processo não sobe quando:

| Combinação detectada | Como |
| --- | --- |
| **dev/test/staging apontando para produção** | `SUPABASE_URL`, `FRONTEND_URL`, `GOOGLE_REDIRECT_URI` ou uma origem de `CORS_ALLOWED_ORIGINS` com host presente em `PRODUCTION_HOSTS`, e `APP_ENV != production` |
| **test com credencial real aparente** | `SUPABASE_SERVICE_ROLE_KEY` com formato de JWT (`eyJ…​.…​.…`) ou `ANTHROPIC_API_KEY` começando com `sk-ant-`, com `APP_ENV=test` ou `NODE_ENV=test` |
| **staging usando callback oficial de produção** | `GOOGLE_REDIRECT_URI` com host de `PRODUCTION_HOSTS` e `APP_ENV=staging` |
| **múltiplas instâncias sem rate-limit compartilhado** | `APP_INSTANCE_COUNT > 1` sem store compartilhado — `assertRateLimitStoreReady()` no `server.js` (fora de teste) lança `rate_limit_store_misconfigured` |

`PRODUCTION_HOSTS` é uma lista CSV que **o operador preenche** com os hosts reais de produção — nenhuma URL é inventada no código.

## 4. Regras

- **development não aponta silenciosamente para produção** → `PRODUCTION_HOSTS` + trava de boot.
- **test não chama APIs externas reais** → toda suíte mocka `supabase` e os libs de WhatsApp/Google/IA; nenhum teste faz rede. Trava adicional bloqueia credencial real em `test`.
- **staging usa credenciais próprias** → `.env.staging.example` com projeto/app/keys separados; boot bloqueia reuso de host de produção.
- **production exige todas as obrigatórias** → `validateEnv` (§2).
- **nenhum segredo real versionado** → `.gitignore` cobre `.env` e `.env.*` (exceto `*.example`); só `.env.example` e `.env.staging.example` (placeholders) no git.

## 4b. Nota — callback do Google e allowlist de redirect (R06)

O `GET /auth/google/callback` só redireciona o navegador de volta ao frontend se
a base (`FRONTEND_URL`) estiver na allowlist de origens (`CORS_ALLOWED_ORIGINS`,
ou `FRONTEND_URL` como fallback). Em **development**, defina as duas:

```
FRONTEND_URL=http://localhost:5173
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

Sem isso, o callback responde `400 redirect_not_allowed` em vez de redirecionar
para fora. Isso é intencional (anti open-redirect) — não é um bug.

## 4c. Limitação operacional — OAuthStateStore (R06)

O `OAuthStateStore` (`src/lib/oauthState.js`) usa **armazenamento em memória do
processo** e é adequado **somente enquanto o backend opera com uma única
instância**. Reinício do processo ou múltiplas instâncias podem invalidar um
fluxo de OAuth em andamento (o usuário recebe `?google=state_invalido` e refaz o
"Conectar").

**Antes de escalar horizontalmente**, migrar o `OAuthStateStore` para
armazenamento **compartilhado e persistente** (Redis/Postgres — ver
`13-adr-redis-job-queue.md`), **preservando**: TTL curto, uso único, vínculo com
usuário e proteção contra replay.

Não fazer essa integração agora. `APP_INSTANCE_COUNT > 1` já derruba o boot
(`assertRateLimitStoreReady`), o que também protege este ponto até a migração.

## 5. Arquivos

- `.env.example` — genérico, todos os nomes + placeholders `xxxxx`.
- `.env.staging.example` — específico de staging, placeholders `REPLACE_…`.
- `src/config/env.js` — schema + `validateEnv` + `detectDangerousCombos`.
- Testes: `test/env-guards.test.js`.
