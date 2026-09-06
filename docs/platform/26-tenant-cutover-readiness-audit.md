# FASE 2.9 — Auditoria de prontidão para cutover multitenant (local)

**Branch:** `foundation/tenant-cutover-readiness`
**Base backend:** `7248d71e0632bb339f7bbb009208fbe816143bd7`
**Base frontend:** `afb097c8e60604778dd3ff1b06aff364317bcd8a`
**Escopo:** provar LOCALMENTE que o Prognexo funciona com a arquitetura nova
ligada (FASES 1A–2.8) sem fallback silencioso para caminhos legados.
**Fora de escopo:** push, deploy, staging remoto, produção, remoção de
`doctor_id`, remoção de estruturas legadas, `NOT NULL` em coluna legada.

> Regra desta etapa: **nenhuma alteração de código antes de a matriz abaixo
> estar completa.** Este documento é o gate.

---

## 1. Fato arquitetural central — RLS vs. API

`src/lib/supabase.js` cria **um único cliente `service_role`** para todo o
backend. `service_role` **bypassa RLS**. Consequências:

- **Toda** a isolação de tenant na superfície HTTP é **código de aplicação**
  (handlers filtrando por `scopedDoctorIds` / `organization_id`).
- As policies RLS e as funções `SECURITY DEFINER` com `search_path=''` +
  `revoke execute from public/anon/authenticated` + guard `auth.uid()` são
  **defesa em profundidade**: protegem as tabelas/RPCs contra acesso direto
  via `anon`/`authenticated` (PostgREST), não contra o backend.
- O frontend usa a `anon key` (`src/api/supabase.js`) e só toca em
  `users` (própria linha), `doctors` (por `owner_user_id`) e Auth — tudo
  protegido por RLS de linha própria. **Não há leitura de dado de negócio
  via PostgREST direto pelo frontend.**

**Implicação para o cutover:** ligar as flags **não** adiciona uma segunda
barreira automática no nível de banco para as rotas que usam `service_role`.
A eliminação de fallback inseguro (ETAPA 5) é o que efetivamente fecha o
tenant. Por isso ela é obrigatória antes de qualquer ativação real.

---

## 2. Inventário de ocorrências (backend / frontend / migrations / testes)

Contagem por termo (arquivos que mencionam), via `git grep`:

| Termo | Arquivos | Onde concentra |
|---|---|---|
| `doctor_id` | 65 | rotas, libs, webhooks, todas as migrations, testes |
| `organization_id` | 45 | `tenantContext`, rotas do corte vertical, migrations 0008/0010/0012/0013/0014 |
| `unit_id` | 15 | `tenantContext`, `memberships`/`membership_units`, migrations 0008/0010 |
| `user_doctor_access` | 20 | `middleware/auth.js`, `authz.js`, `teamShadowRead.js`, `/team`, RPCs 0012 |
| `organization_doctor_map` | 20 | `tenantContext.js`, `teamShadowRead.js`, rotas, 0008/0012 |
| `tenantContext` | 15 | `src/lib/tenantContext.js` + 13 routers do corte vertical |
| `getScopedDoctorIds` | 20 | `middleware/auth.js` (def), `authz.js`, todas as rotas legadas |
| `TENANT_CORE_ENABLED` | 19 | `env.js`, `tenantContext.js`, `teamShadowRead.js`, testes |
| `TEAM_MEMBERSHIPS_ENABLED` | 5 | `env.js`, `/team`, RPC 0012, testes |
| `TEAM_INVITE_OUTBOX_ENABLED` | 9 | `env.js`, `credentialVault.js`, `/jobs`, outbox, testes |
| `TOKEN_ENCRYPTION_ENABLED` | 9 | `env.js`, `credentialVault.js`, testes |
| `PERSISTENT_JOB_QUEUE_ENABLED` | 5 | `env.js`, `credentialVault.js`, `/jobs`, `campanhas.js`, testes |
| `USAGE_QUOTAS_ENABLED` | 3 | `env.js`, `campaignSendHandler.js`, testes |
| `CAMPAIGN_JOB_QUEUE_ENABLED` | 5 | `env.js`, `campanhas.js`, `/jobs`, testes |
| `service_role` | 13 | `env.js`, `supabase.js`, `backfill-embeddings.js`, migrations, testes |

### 2.1 `attachTenantContext` — cobertura de rotas

No-op quando `TENANT_CORE_ENABLED=false`. Montado em **13 routers** (corte
vertical FASES 2.1/2.3/2.6/2.7):

`leads`, `deals`, `dashboard`, `events`, `campanhas`, `conversations`,
`knowledge-base`, `bdr`, `integrations`, `patients`, `reports`, `team`,
`team/invitations`.

**NÃO montado** em: `doctors`, `signup`, `activation`, `onboarding`,
`auth/google`, `planos`, `playground`, `jobs`, `tenant`, `webhooks/*`.

### 2.2 Resolvedor de tenant (`src/lib/tenantContext.js`)

`resolveTenantContext(req)` — comportamento (confirmado no código):

- `organization_id` **nunca** do body; só `X-Organization-Id` / `?organization_id`.
- 1 membership ativa → usada. `>1` sem header → **409 `organization_selection_required`**.
- header com org sem membership ativa e não platform_admin → **403 `no_membership_for_org`**.
- sem membership e não platform_admin → **403 `no_active_membership`**.
- `X-Unit-Id` fora da org / fora das unidades da membership → **403**.
- platform_admin = linha em `platform_admins` **OU** `user.role === 'admin'` (legado).
- **FASE 2.9:** platform_admin sem org selecionada numa rota tenant-scoped ⇒ 409
  `organization_selection_required`; com org selecionada fica LIMITADO a ela.
- `doctorId` de compat derivado de `organization_doctor_map` (1 doctor por org hoje).
- **FASE 2.9:** org sem `organization_doctor_map` ⇒ 409 `tenant_backfill_required` (todos).

`scopedDoctorIds(req, getScopedDoctorIds)` / `tenantAllowsDoctor(...)` / `authz.js#resolveScope`:
- core ON → **sempre** `[doctorId]` da org selecionada (nunca `null`, nunca legado).
- core OFF → delega ao legado `getScopedDoctorIds(req.user)`.

### 2.3 Autorização de mutação (`src/lib/authz.js`)

`authorizeResource` / `assertRelatedBelongs` / `assertUserAccess` chamam
**`getScopedDoctorIds(user)` diretamente** — **não recebem `req`, não
consultam `req.tenant`**. Portanto `PATCH`/`DELETE` de `leads`, `deals`,
`events`, etc. autorizam **sempre pelo legado**, mesmo com
`TENANT_CORE_ENABLED=true`. → ver B1 na §4.

### 2.4 Rotas fora do corte vertical que usam só o legado

`doctors.js` e `playground.js` — `getScopedDoctorIds(req.user)` puro, sem
`attachTenantContext`. Com core ON continuam decidindo por
`doctors.owner_user_id` / `user_doctor_access`. → ver B2 na §4.

### 2.5 Shadow-read existente

`src/lib/teamShadowRead.js` (FASE 2.3): compara `user_doctor_access` × 
`memberships` por doctor, **loga** `onlyLegacy` / `onlyMembership` /
`legacyButSuspendedMembership`, **nunca corrige**. Base para a ETAPA 6, mas
só cobre equipe — falta shadow-read de leitura de negócio (leads/deals/
events) e contadores de métrica nomeados.

### 2.6 Workers / cron (`src/routes/jobs.js`)

| Endpoint | Auth | Observação |
|---|---|---|
| `POST /jobs/campaign-outbox` | **header** `Authorization: Bearer` / `X-Prognexo-Job-Token`, timing-safe (FASE 2.8) | 404 se as flags de fila/campanha estiverem OFF |
| `POST /jobs/team-invite-outbox` | `?secret=CRON_SECRET` (query string) | inconsistente com o de cima; query string **não** é logada (serializer do pino em `server.js`) |
| `POST /jobs/limpar-leads-esquecidos` | `?secret=CRON_SECRET` (query string) | cron de manutenção, **global por design**, sem escopo de tenant (regra de negócio uniforme) |

### 2.7 Webhooks

`webhooks/whatsapp.js` resolve `doctor_id` + `organization_id` a partir da
linha de `integrations` localizada pelo **webhook token** — inerentemente
tenant-scoped e correto. Grava `organization_id` em `conversations` quando a
integração já tem (ponte). Webhooks de pagamento: mesmo padrão (token→tenant).
→ **global por design**; nenhuma mudança nesta fase; **Meta intocada**.

### 2.8 Frontend

| Ponto | Classe |
|---|---|
| `src/api/client.js` + `tenantSelection.js` | injeta `X-Organization-Id` / `X-Unit-Id`; corpo nunca leva `organization_id`/`user_id`/`role` (`query.js` `TENANT_AUTHORITY_KEYS` bloqueia) — **novo e pronto** |
| `src/App.jsx` seleção de org via `/tenant/context` (`suggested` só quando `length === 1`) | **novo e pronto** |
| `src/App.jsx:67` `supabase.from('doctors')...owner_user_id` | **ponte compatível** (poderia vir de `/tenant/context`) |
| `src/App.jsx:186/196`, `src/pages/Login.jsx:28` `users` própria linha | **legado necessário** (perfil próprio; RLS de linha própria) |
| `src/pages/AceitarConvite.jsx` | **novo e pronto** (FASE 2.7) |

---

## 3. Matriz de classificação de caminhos

Legenda: **NP** novo e pronto · **PC** ponte compatível · **LN** legado
necessário · **FI** fallback inseguro · **GD** global por design · **BC**
bloqueador de cutover · **RF** remoção futura

| # | Caminho / componente | Arquivo | Classe | Nota |
|---|---|---|---|---|
| 1 | `resolveTenantContext` (header-only, 409/403 corretos) | `lib/tenantContext.js` | NP | — |
| 2 | `/tenant/context` (não escolhe org sozinho) | `routes/tenant.js` | NP | — |
| 3 | `memberships` / `membership_units` / RPCs 0012 | `migrations/0012` | NP | — |
| 4 | `organization_invitations` / outbox / RPCs 0013 | `migrations/0013` | NP | — |
| 5 | `job_queue` / `usage_*` / RPCs 0014 + `campaign_recipient_enqueue` | `migrations/0014` | NP | — |
| 6 | Injeção `X-Organization-Id`/`X-Unit-Id` + bloqueio de authority keys no corpo | `frontend/src/api/*` | NP | — |
| 7 | `scopedDoctorIds(req,…)` / `tenantAllowsDoctor(req,…)` nas LISTAS do corte vertical | `lib/tenantContext.js` + 13 routers | PC | correto com core ON; delega ao legado com core OFF |
| 8 | `organization_doctor_map` (1 doctor ⇄ 1 org) | `migrations/0008/0012` | PC | ponte de compat; não some nesta fase |
| 9 | `user_doctor_access` como ponte para `role='closer'` | `middleware/auth.js`, RPCs 0012 | LN | decisão FASE 2.6 |
| 10 | Colunas `doctor_id` em todas as tabelas | schema inteiro | LN | **nunca** removidas nesta fase |
| 11 | `users.role` (`admin`/`doctor`/`closer`) RBAC legado | schema + middleware | LN | coexiste com `memberships.role` |
| 12 | `webhooks/whatsapp` + pagamentos (token→tenant) | `webhooks/*` | GD | inbound; sem sessão de usuário |
| 13 | `/jobs/*` workers/cron (claim `SKIP LOCKED`, regra uniforme) | `routes/jobs.js` | GD | disparo por scheduler único |
| 14 | `job_type='system.maintenance'` sem `organization_id` (allowlist no CHECK) | `migrations/0014` | GD | único tipo global permitido |
| 15 | `App.jsx:67` `doctors` por `owner_user_id` | `frontend/src/App.jsx` | PC | mover p/ `/tenant/context` no futuro |
| 16 | **`authz.js` (`authorizeResource`/`assertRelatedBelongs`/`assertUserAccess`) usa `getScopedDoctorIds` legado, ignora `req.tenant`** | `lib/authz.js` | **FI / BC** | mutações não apertam com core ON — ver B1 |
| 17 | **`doctors.js` / `playground.js` — `getScopedDoctorIds(req.user)` puro, sem `attachTenantContext`** | `routes/doctors.js`, `routes/playground.js` | **FI / BC** | com core ON continuam por `owner_user_id` — ver B2 |
| 18 | **`TEAM_MEMBERSHIPS_ENABLED` sem boot guard exigindo `TENANT_CORE_ENABLED`** | `config/env.js` | **BC** | ver B3 |
| 19 | **`TEAM_INVITE_OUTBOX_ENABLED` sem boot guard exigindo `TEAM_MEMBERSHIPS_ENABLED`** | `config/env.js` | **BC** | `validateTeamInviteOutbox` só checa `delivery→outbox` — ver B4 |
| 20 | **Sem inventário de linhas sem `organization_id`** para `leads`/`deals`/`events`/`conversations`/`transactions`/`atendimentos` (só campanhas tem, da 2.8) | — | **BC** | ETAPA 4 — ver B5 |
| 21 | `integrations` GET → `400 doctor_id necessário` quando core ON e org sem `organization_doctor_map` | `routes/integrations.js:57` | FI (fraco) | fail-closed, mas devia ser `409 tenant_backfill_required` p/ consistência com campanhas |
| 22 | `/jobs/team-invite-outbox` e `/limpar-leads-esquecidos` com `?secret=` | `routes/jobs.js` | RF | padronizar para header (não bloqueia esta fase; query não é logada) |
| 23 | `campanhas.js` GET/POST ainda exigem `doctor_id` no query/body (validado por `tenantAllowsDoctor`) | `routes/campanhas.js` | PC | corpo ainda carrega `doctor_id`; autoridade é o contexto |
| 24 | `LEGACY_CARD_CHECKOUT_ENABLED`, `PAYMENT_WEBHOOKS_*`, `TICTO_WEBHOOK_ENABLED` | `config/env.js` | LN | fora do escopo de tenancy; permanecem como estão |
| 25 | Shadow-read de equipe (`teamShadowRead.js`) — só loga | `lib/teamShadowRead.js` | PC | estender na ETAPA 6 (métricas + leitura de negócio) |
| 26 | `resolveDoctorId` de `integrations` ignora `?doctor_id`/body quando core ON | `routes/integrations.js:36` | NP | comportamento correto |
| 27 | `TOKEN_ENCRYPTION_ENABLED` exige keyring/active key/HMAC no boot | `config/env.js` `validateTokenEncryption` | NP | — |
| 28 | `PERSISTENT_JOB_QUEUE_ENABLED` exige keyring + `JOB_RUNNER_SECRET`; `CAMPAIGN_JOB_QUEUE` exige `PERSISTENT` (+ `USAGE_QUOTAS` em staging/prod) | `config/env.js` `validatePersistentJobs` | NP | falta só a dependência de tenancy (não aplicável — fila é tenant-scoped na RPC) |

---

## 4. Bloqueadores de cutover (a resolver nas ETAPAS 3–6, **sem commit**)

- **B1 — `authz.js` não é tenant-aware.** `authorizeResource` e afins
  autorizam mutação por `getScopedDoctorIds` legado mesmo com core ON. Um
  usuário com membership revogada mas com linha remanescente em
  `user_doctor_access` (ou dono do `doctors`) ainda faria `PATCH`/`DELETE`.
  **Correção (ETAPA 5):** passar `req` e, quando `req.tenant?.enabled`,
  derivar o escopo do contexto (`req.tenant.doctorId` / `isPlatformAdmin`);
  divergência ⇒ 403/404 conforme contrato, nunca decisão silenciosa.

- **B2 — `doctors.js` / `playground.js` fora do corte vertical.** Com core
  ON continuam por `owner_user_id`/`user_doctor_access`. **Correção:** montar
  `attachTenantContext` e trocar para `scopedDoctorIds(req,…)` /
  `tenantAllowsDoctor(req,…)`; manter comportamento idêntico com a flag OFF.

- **B3 — boot guard ausente: `TEAM_MEMBERSHIPS_ENABLED ⇒ TENANT_CORE_ENABLED`.**
  Sem isso, `/team` passaria a ler/escrever `memberships` enquanto as
  demais rotas ainda resolvem doctor pelo legado — split-brain de
  autorização. **Correção (ETAPA 3):** derrubar o boot.

- **B4 — boot guard ausente: `TEAM_INVITE_OUTBOX_ENABLED ⇒ TEAM_MEMBERSHIPS_ENABLED`.**
  `validateTeamInviteOutbox` só valida `delivery ⇒ outbox`. Convite cria
  `membership` com status `invited`; sem o módulo de memberships ligado o
  aceite fica inconsistente. **Correção (ETAPA 3):** derrubar o boot.

- **B5 — sem inventário pré-cutover de linhas órfãs.** Só campanhas têm
  (`scripts/check-campaigns-without-org.js`, FASE 2.8). Falta cobrir
  `leads`/`deals`/`events`/`conversations`/`transactions`/`atendimentos`,
  doctors sem `organization_doctor_map`, memberships ausentes/inválidas,
  usuário multi-org sem seleção, integrações sem org, jobs/convites/outbox
  presos, reservas de quota órfãs, divergência `user_doctor_access` ×
  `memberships`, tokens plaintext restantes. **Correção (ETAPA 4):**
  `scripts/check-tenant-cutover-readiness.js` (somente leitura).

Nenhum desses toca `doctor_id`, remove estrutura legada ou cria `NOT NULL`.

---

## 5. Riscos residuais herdados (documentados, não bloqueiam a fase)

- `job_claim` sem fairness por org (FASE 2.8).
- `usage_aggregate` não agrupa por currency (BRL-only hoje).
- Janelas de quota em UTC (reset ~21h BRT).
- Reserva órfã de dead_letter liberada só pelo sweep de 24h.
- Crash pós-Meta-pré-settle pode reenviar (não exactly-once) — mesma classe
  da FASE 2.7.
- 7 vulnerabilidades `moderate` pré-existentes no backend (`googleapis` →
  `uuid`); frontend 1 moderate + 1 high (`esbuild`/`vite`, dev-only). Sem
  dependência nova nesta fase.

---

## 6. Próximas etapas (ordem)

3. Matriz de flags + boot guards (B3, B4) + `docs/platform/27-flag-activation-matrix.md`.
4. `scripts/check-tenant-cutover-readiness.js` (B5) + testes.
5. Eliminação de fallbacks inseguros (B1, B2, item 21) + testes.
6. Shadow-read de leitura de negócio + contadores + flag própria.
7. Teste local com as 7 flags ON (20 fluxos).
8. Teste de compatibilidade com as flags OFF.
9. Revisão adversarial.
10. Validação final.

**Gate satisfeito: a matriz está completa. Alterações de código liberadas a
partir da ETAPA 3.**

---

## 7. Revisão adversarial (ETAPA 9) — mudanças da FASE 2.9

Nenhuma migration/RPC/SQL foi alterada nesta fase. Todas as mudanças são
JS de aplicação + testes + docs. Zero dependência nova.

| Vetor | Avaliação |
|---|---|
| **cross-tenant** | `authorizeResource` agora escopa por `req.tenant.doctorId` (idêntico a `scopedDoctorIds`). Linha de outra org ⇒ `forbidden` antes de qualquer efeito. Teste: `tenant-cutover-flags` PATCH /leads/lB. |
| **confused deputy** | `assertUserAccess` com tenant ON exige `legacyOk && membership ativa` na org do contexto — linha órfã em `user_doctor_access` não reautoriza. |
| **mass assignment** | Nenhum campo novo aceito no corpo. `respondDoctorIdGap` não lê body. `doctors.js` POST mantém whitelist. |
| **seleção silenciosa de organização** | `resolveTenantContext` intacto (409 multi-org). `scopedDoctorIds`/shadow-read nunca escolhem "a primeira". |
| **fallback legado** | `authorizeResource`: bypass de `role==='admin'` só com `!req.tenant.enabled`. `resolveScope`: com tenant ON nunca chama `getScopedDoctorIds`. `assertUserAccess`: exige AMBOS (mais estrito, não fallback). |
| **privilege escalation** | `doctors.js` POST aceita `req.tenant.isPlatformAdmin` — mesma autoridade que `role==='admin'` já concedia + linha explícita em `platform_admins`. Não amplia. |
| **RLS vs API** | Inalterado. `service_role` continua no backend (§1). Mitigação = aperto na camada de aplicação (ETAPA 5), documentado. |
| **service_role sem filtro** | Nenhuma query nova sem filtro. `/tenant/shadow-metrics` checa `platform_admins` e devolve só contadores (sem IDs/org). |
| **flags parcialmente ligadas** | `validateTenantFlagChain` derruba o boot: `memberships⇒core`, `outbox⇒memberships`. Testes em `env-guards`. |
| **rollback de flags** | `TENANT_CORE_ENABLED=false` ⇒ `attachTenantContext` no-op ⇒ `req.tenant` undefined ⇒ `resolveScope` volta a `getScopedDoctorIds`. Reversão limpa; testes "flags OFF" em `tenant-cutover-flags`. |
| **jobs no tenant errado / quotas na org errada** | Sem mudança em jobs/quotas nesta fase. |
| **tokens / logs / erros** | Shadow-read loga só contagens (`onlyLegacy.length`), nunca IDs. `check-tenant-cutover-readiness` devolve só UUIDs técnicos + contagens (testado: sem valor de token, sem PII). Erros: `forbidden`/`not_found`/`tenant_backfill_required` genéricos. |
| **Realtime / migrações / Meta** | Não tocados. `integrations.js` só troca 400→409 no gap de `organization_doctor_map`; nenhuma chamada à Meta alterada. |
| **concorrência** | Contadores do shadow-read são `+=` num singleton de módulo; sem `await` entre leitura e escrita do contador (Node single-thread) — seguro para métrica agregada. Nunca influencia a decisão de acesso. |

**Achados que exigiram correção durante a revisão:**

- **platform_admin "vê tudo" como fallback (CORRIGIDO na 2ª rodada).** Antes,
  `scopedDoctorIds`/`resolveScope`/`tenantAllowsDoctor` devolviam `null`
  ("vê tudo") quando o request era platform_admin sem `doctorId` resolvido
  (sem org selecionada, ou org sem `organization_doctor_map`). Agora:
  - `resolveTenantContext` — platform_admin **sem** organização selecionada
    numa rota tenant-scoped ⇒ **409 `organization_selection_required`**;
  - `resolveTenantContext` — organização selecionada **sem**
    `organization_doctor_map` ⇒ **409 `tenant_backfill_required`** para
    TODOS (inclusive platform_admin);
  - `scopedDoctorIds`/`resolveScope`/`tenantAllowsDoctor` — nunca mais
    retornam `null` com tenant ON; sempre `[doctorId]` da org selecionada;
  - acesso global **só** em endpoint EXPLICITAMENTE global, que não usa
    `attachTenantContext`: `POST /doctors` (via `isPlatformAdminUser`) e
    `GET /tenant/shadow-metrics`. `doctors.js` deixou de aplicar
    `attachTenantContext` no router inteiro — só nas rotas tenant-scoped
    (`GET /`, `PATCH /:id/ia`, `POST /:id/ia/gerar-contexto`).
  - Testes: `test/tenant-platform-admin.test.js` (12 casos).
- Ajustes de testes preexistentes que codificavam o comportamento antigo
  (`tenant-endpoint.test.js`: cross-tenant agora barra como `forbidden`;
  `team-invite-outbox.test.js` / `env-guards.test.js`: passaram a ligar a
  cadeia `core→memberships→outbox`).

**Invariante de compat assumida pela FASE 2.9:** toda organização ativa tem
uma linha em `organization_doctor_map` (a migration 0008 cria uma por doctor
existente). Uma org sem map = lacuna de backfill ⇒ 409 uniforme em qualquer
rota tenant-scoped. `check-tenant-cutover-readiness` (`doctors_sem_map`)
detecta isso antes de ligar as flags.

**Riscos residuais (aceitos):**

- Shadow-read é in-process: contadores zeram a cada boot e não são agregados
  entre instâncias. Suficiente para o ensaio local.
- platform_admin numa rota tenant-scoped precisa mandar `X-Organization-Id`
  em toda sessão (não há mais "modo global implícito"). É a UX correta pelo
  requisito de segurança.

---

## 8. Rastreabilidade dos 20 fluxos (ETAPA 7)

Cada fluxo → arquivo de teste + caso + resultado real (suíte serializada,
Postgres local pós-`db reset`, 476/476).

| # | Fluxo | Arquivo(s) de teste | Caso representativo | Resultado |
|---|---|---|---|---|
| 1 | login / auth | `test/activation.test.js` | "sem token → 401", "JWT inválido → 401", "e-mail não confirmado → 403", "ativação válida" | ✅ |
| 2 | seleção de organização | `test/tenant-endpoint.test.js`; `test/tenant-context.test.js` | "GET /tenant/context" (1 org / >1 org / sem membership / suspensa); "usuário com 2 orgs SEM header → 409" | ✅ |
| 3 | papéis owner/admin/manager/closer/receptionist | `test/team-api.test.js`; `test/rls/team-memberships.rls.test.js` | "closer/viewer não podem GET → 403"; hierarquia `team_actor_can_manage_target` (enum de papéis, inclui manager/receptionist) | ✅ |
| 4 | leads | `test/tenant-context.test.js`; `test/tenancy.test.js`; `test/tenant-cutover-flags.test.js`; `test/rls/tenant-core.rls.test.js` | "flag=true: GET /leads usa a org da membership"; "doctor A NÃO altera lead da clínica B" | ✅ |
| 5 | deals | `test/tenancy.test.js`; `test/rls/tenant-core.rls.test.js` | "doctor A NÃO move deal da clínica B (PATCH /deals/:id/etapa)"; "GET /deals mantém o achatamento do kanban" | ✅ |
| 6 | eventos | `test/tenancy.test.js` | "doctor A NÃO marca status de evento da clínica B"; "POST /events cross-tenant" | ✅ |
| 7 | campanhas | `test/campaigns-job-queue.test.js`; `test/campaign-concurrency.test.js` | "flag on + org: 202 só depois do dispatch persistido"; "duas requisições simultâneas: uma dispara, outra 409" | ✅ |
| 8 | conversas | `test/tenancy.test.js`; `test/tenant-endpoint.test.js`; `test/tenant-cutover-flags.test.js` | "doctor A NÃO envia WhatsApp para lead da clínica B"; "enviar mensagem p/ lead de OUTRA org → 403"; **"fluxo 8 — GET /conversations escopa pela org selecionada" (NOVO)** | ✅ |
| 9 | knowledge base | `test/rls/tenant-expansion.rls.test.js`; `test/rls/tenant-isolation.rls.test.js`; `test/tenant-cutover-flags.test.js` | RLS de `knowledge_base`/`knowledge_chunks`; **"fluxo 9 — GET /knowledge-base: doctor de outra org → 403" (NOVO)** | ✅ |
| 10 | integrações sem exposição de token | `test/token-encryption-integration.test.js`; `test/webhook-token-rotate.test.js` | "nenhuma resposta HTTP de /integrations contém token nem ciphertext" | ✅ |
| 11 | Google status sem chamada externa | `test/oauth-google.test.js`; `test/oauth-google-redirect.test.js`; `test/rls/tenant-core.rls.test.js` | "state seguro / replay / redirect allowlist"; "view `google_connection_status` retorna só estado, nunca o token" | ✅ |
| 12 | equipe | `test/team-api.test.js`; `test/rls/team-memberships.rls.test.js` | "GET /team lista memberships"; add/change-role/suspend/remove; último owner protegido | ✅ |
| 13 | convite → outbox fake → aceite | `test/team-invitations-api.test.js`; `test/team-invite-outbox.test.js`; `test/rls/team-invitations.rls.test.js` | "POST usa tenant do contexto"; "link de aceite montado com hashed_token"; "accept ignora corpo e usa só o Bearer" | ✅ |
| 14 | campanha → dispatch → send fake → finalize | `test/campaigns-job-queue.test.js` | "dispatch: 1 par por destinatário via RPC atômica"; "finalize: drena e conclui"; "send happy path: reserve→send→settle" | ✅ |
| 15 | quotas | `test/campaigns-job-queue.test.js`; `test/rls/persistent-jobs-and-quotas.rls.test.js` | "send quota negada: nunca chama send, retry, sem settle"; "hard limit + concurrent reserve nunca excede" | ✅ |
| 16 | usuário multi-org | `test/tenant-context.test.js`; `test/tenant-cutover-flags.test.js`; `test/tenant-platform-admin.test.js`; `test/rls/tenant-core.rls.test.js` | "2 orgs SEM header → 409"; "MULTI seleciona Org A → vê lead da Org A" | ✅ |
| 17 | membership suspensa | `test/tenant-endpoint.test.js`; `test/tenant-cutover-flags.test.js`; `test/team-api.test.js` | "membership suspensa não concede acesso"; "membership suspensa → 403"; "closer suspenso não vira ator" | ✅ |
| 18 | cross-tenant | `test/tenancy.test.js`; `test/tenant-endpoint.test.js`; `test/tenant-platform-admin.test.js`; `test/rls/tenant-isolation.rls.test.js` | 5 casos "doctor A NÃO … clínica B"; "cancel cross-tenant é sempre 404"; RLS de isolamento | ✅ |
| 19 | platform admin | **`test/tenant-platform-admin.test.js` (NOVO — 12 casos)** | "sem X-Organization-Id → 409"; "com ORG_A → só DOC_A"; "org sem map → 409 tenant_backfill_required"; "PATCH cross-org → 403/404"; "POST /doctors global → 201" | ✅ |
| 20 | logout e troca de organização | `test/tenant-cutover-flags.test.js`; `test/tenant-platform-admin.test.js`; frontend `tenantSelection.test` | **"fluxo 20 — troca de organização na mesma sessão re-escopa os dados" (NOVO)**; logout = signout do Supabase Auth no cliente (sem rota backend) → `tenantSelection.clear()` coberto no frontend (51/51) | ✅ |

**Lacunas fechadas nesta rodada:** fluxos 8 (GET /conversations), 9 (GET
/knowledge-base), 19 (platform_admin — arquivo novo), 20 (troca de org na
mesma sessão) ganharam casos dedicados.
