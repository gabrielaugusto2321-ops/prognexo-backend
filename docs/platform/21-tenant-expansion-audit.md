# FASE 2.3 — Auditoria de compatibilidade para expansão do tenancy

Inventário **antes de qualquer implementação** (ETAPA 2). Base: backend `1bae72a`,
frontend `16ef8b9`, branch `foundation/tenant-expansion`.

Complementa [18-tenancy-compat-audit.md](18-tenancy-compat-audit.md) (FASE 2.1) e
[20-token-encryption-rollout.md](20-token-encryption-rollout.md) (FASE 2.2).

## Legenda de classificação

| classe | significado |
|---|---|
| **MIGRADA** | já resolve tenant via `tenantContext` (corte vertical FASE 2.1) |
| **PONTE** | resolve tenant por identificador confiável do servidor (doctor_id / phone_number_id / webhook_token) — compatível, aguarda expansão |
| **LEGADA** | ainda 100% `doctor_id` via `getScopedDoctorIds`; alvo desta fase |
| **GLOBAL** | recurso de plataforma, não pertence a um tenant |
| **N/A** | pré-auth, self-scoped por `auth.uid()`, ou sem acesso a dados de tenant |
| **BLOQUEADA** | não pode entrar em cutover sem quebrar algo — documentado |

## 1. Rotas backend

| rota | arquivo | escopo atual | tabelas | classe | observação |
|---|---|---|---|---|---|
| `/leads` | routes/leads.js | `attachTenantContext` + `scopedDoctorIds` + `leads_org_scoped` (0008) | leads, deals, conversations | **MIGRADA** | INSERT grava `organization_id` do contexto; `doctor_org_mismatch` |
| `/deals` | routes/deals.js | `attachTenantContext` + `scopedDoctorIds` | deals, leads | **MIGRADA** | tenant via `leads.organization_id` (policy `deals_org_scoped`) |
| `/events` | routes/events.js | `attachTenantContext` + `scopedDoctorIds` | events, atendimentos, users | **MIGRADA** | INSERT grava `organization_id`+`unit_id`; `atendimentos` ainda sem coluna org |
| `/campanhas` | routes/campanhas.js | `attachTenantContext` + `tenantAllowsDoctor` | campanhas, campanha_envios, leads, conversations | **MIGRADA** | envio usa `CredentialVault` (FASE 2.2) |
| `/conversations` | routes/conversations.js | `getScopedDoctorIds` → `lead.doctor_id` (via `authorizeResource`) | conversations | **LEGADA** | prioridade 1. `conversations` sem `doctor_id`/`organization_id` → tenant só via `lead_id` |
| `/integrations` | routes/integrations.js | `resolveDoctorId` (`owner_user_id` / admin+`?doctor_id`) | doctors, integrations | **LEGADA** | prioridade 2. SELECT do browser já revogado (0009); credenciais via `CredentialVault` |
| `/auth/google` | routes/googleAuth.js | `user_id` do OAuth state (servidor) | users, google_tokens | **N/A (user-scoped)** | prioridade 3 só p/ ligar `google_tokens` a org via `organization_doctor_map` para relatórios |
| `/knowledge-base` | routes/knowledgeBase.js | `getScopedDoctorIds` via `checarAcesso` | knowledge_base | **LEGADA** | prioridade 4. tem `doctor_id` |
| (RAG) | lib/knowledgeChunks.js | `doctorId` explícito na chamada | knowledge_chunks | **LEGADA** | prioridade 5. tem `doctor_id`; usado por `iaAgent`/webhook |
| `/dashboard` | routes/dashboard.js | `getScopedDoctorIds` | leads, transactions, conversations | **LEGADA** | prioridade 9 (relatórios). `transactions` sem `doctor_id` → via `deal→lead` |
| `/reports` | routes/reports.js | `getScopedDoctorIds` | deals, events, atendimentos, users | **LEGADA** | prioridade 9 |
| `/patients` | routes/patients.js | `getScopedDoctorIds` → `leads.doctor_id` join | atendimentos, leads | **LEGADA** | prioridade 7 (atendimentos). `atendimentos` sem coluna de tenant |
| `/bdr` | routes/bdr.js | `getScopedDoctorIds` via `checarAcesso` | ia_agentes_bdr | **LEGADA** | prioridade 8 (agentes IA). `ia_agentes_bdr` tem `doctor_id` (unique) |
| `/team` | routes/team.js | `getScopedDoctorIds` | doctors, users, user_doctor_access, leads | **LEGADA** | prioridade 10 (equipe). Gestão de acesso — **cutover exige migrar `user_doctor_access` → `memberships`**; aditivo por ora |
| `/doctors` | routes/doctors.js | `getScopedDoctorIds` | doctors | **PONTE** | lista os "doctors" (clínicas) do usuário; no modelo novo = organizations. Mantém compat via `organization_doctor_map` |
| `/onboarding` (+`src/onboarding.js` dup.) | routes/onboarding.js | `getScopedDoctorIds` | integrations, leads, deals, transactions, doctors, user_doctor_access | **LEGADA** | só leitura de status; baixo risco |
| `/playground` | routes/playground.js | `getScopedDoctorIds` | doctors | **LEGADA** | ferramenta de teste de IA; baixa prioridade |
| `/jobs` | routes/jobs.js | `CRON_SECRET` + service-role | conversations, deals, leads | **GLOBAL** | cron de aquecimento/limpeza; roda cross-tenant por design; **não** deve receber `X-Organization-Id` |
| `/signup` | routes/signup.js | pré-auth (captcha) | users, doctors | **N/A** | cria tenant novo |
| `/activation` | routes/activation.js | token de ativação | users, doctors | **N/A** | |
| `/planos` | routes/planos.js | `requireAuth` self | users, doctors | **N/A** | checkout legado (503 em prod) |
| `/health` | server.js | público | — | **GLOBAL** | |
| `/webhooks/whatsapp` | webhooks/whatsapp.js | `phone_number_id` → `integrations.doctor_id` (servidor) | integrations, doctors, leads, deals, conversations | **PONTE** | resolução de tenant **confiável**; não muda |
| `/webhooks/{pagarme,kiwify,hotmart,ticto}` | webhooks/paymentFactory.js | `X-Prognexo-Webhook-Token` → blind index → `doctor_id` (servidor) | integrations, transactions, deals, leads, webhook_events | **PONTE** | resolução confiável (FASE 2.2); não muda |

## 2. Tabelas — estado de tenancy

| tabela | `doctor_id` | `organization_id` | `unit_id` | RLS browser | derivação de tenant | classe |
|---|---|---|---|---|---|---|
| `organizations` / `units` / `memberships` / `membership_units` | — | (é o próprio) | — | policies 0008 | — | **MIGRADA** (núcleo) |
| `organization_doctor_map` / `tenant_backfill_issues` / `platform_admins` | — | — | — | **deny-all** (0008) | — | **GLOBAL** (service-role) |
| `leads` | ✅ | ✅ (0008) | — | doctor + `leads_org_scoped` | direto | **MIGRADA** |
| `events` | ✅ | ✅ (0008) | ✅ (0008) | doctor + `events_org_scoped` | direto | **MIGRADA** |
| `campanhas` | ✅ | ✅ (0008) | — | `campanhas_org_scoped` (browser deny p/ SELECT via 0003) | direto | **MIGRADA** |
| `deals` | — | — | — | `deals_org_scoped` via `leads` (0008) | `lead_id → leads` | **MIGRADA** (herda de leads) |
| `integrations` | ✅ | ✅ (0008) | — | SELECT revogado (0009); INSERT/UPD/DEL policy doctor | direto | **PONTE→alvo** |
| `google_tokens` | — (`user_id` PK) | — | — | `self_manage` + SELECT revogado (0009) | `user_id` | **N/A / PONTE** (ligar a org p/ relatórios via map) |
| `conversations` | — | — | — | **deny-all** | `lead_id → leads.doctor_id` | **LEGADA** (alvo 1) |
| `knowledge_base` | ✅ | — | — | **deny-all** (0003) | direto | **LEGADA** (alvo 4) |
| `knowledge_chunks` | ✅ | — | — | **deny-all** (0003) | direto | **LEGADA** (alvo 5) |
| `transactions` | — | — | — | **deny-all** | `deal_id → deals → lead → leads.doctor_id` | **LEGADA** (alvo 6) |
| `atendimentos` | — | — | — | `doctor_scoped_atendimentos` via `lead` | `lead_id → leads.doctor_id` | **LEGADA** (alvo 7) |
| `ia_agentes_bdr` | ✅ (unique) | — | — | **deny-all** | direto | **LEGADA** (alvo 8) |
| `products` | ✅ | — | — | **deny-all** | direto | **LEGADA** (não priorizado; usado em deals) |
| `campanha_envios` | — | — | — | **deny-all** | `campanha_id → campanhas` | **MIGRADA** (herda) |
| `webhook_events` | — | — | — | **deny-all** | global (idempotência) | **GLOBAL** |
| `users` | — | — | — | `self_read` + `doctor_reads_own_closers` | `auth.uid()` / equipe | **PONTE** (cutover → `memberships`) |
| `doctors` | (é o id) | — | — | owner + closer-scoped | `owner_user_id` / `user_doctor_access` | **PONTE** (= organization no map) |
| `user_doctor_access` | ✅ | — | — | self + doctor-reads | — | **BLOQUEADA p/ cutover** (fonte de verdade da equipe legada; `memberships` é o alvo, mas remover exige cutover definitivo — fora desta fase) |

## 3. Usos de `doctor_id`

- **Rotas que enviam `doctor_id` no body/query:** `/leads` (body), `/events` (body), `/campanhas` (body/query), `/bdr` (body/query), `/knowledge-base` (body/query), `/team` (body/query), `/patients` (query), `/reports` (query), `/dashboard` (query), `/integrations` (body p/ admin), `/onboarding` (query), `/playground`.
  - Todos **validados server-side** contra `getScopedDoctorIds`/`checarAcesso`/`resolveDoctorId` — `doctor_id` do cliente **nunca é fonte de autoridade** hoje. Segue assim.
- **Compat na expansão:** `tenantContext` já resolve `doctorId` a partir de `organization_doctor_map` quando `TENANT_CORE_ENABLED=true` (`scopedDoctorIds`/`tenantAllowsDoctor`). A expansão reусa esse mesmo mecanismo — nenhuma tabela perde `doctor_id`.

## 4. Usos de `organization_id` / `unit_id`

- **Colunas existentes:** `leads.organization_id`, `events.organization_id`, `events.unit_id`, `campanhas.organization_id`, `integrations.organization_id` (0008).
- **Código:** `tenantContext.resolveTenantContext` lê `X-Organization-Id` header / `?organization_id`; `leads/events/campanhas` POST gravam do contexto. `unit_id` só em `events` (do `defaultUnitId` do map).
- **Nunca aceito do body** — `createSchema` de leads/events é `.strict()` e não inclui `organization_id`; teste `test/tenant-context.test.js` cobre "body organization_id ignorado".
- **Faltando:** `X-Unit-Id` ainda não é lido em lugar nenhum; `resolveTenantContext` calcula `unitIds` da membership mas não valida um `unit_id` requisitado.

## 5. Acessos service-role

Único cliente: `src/lib/supabase.js` (`createClient(SUPABASE_URL, SERVICE_ROLE_KEY)`) — **bypassa RLS**. Usado por **todas** as rotas e libs de backend. Consequência: a segurança de tenant no backend depende **inteiramente** do código de escopo (`getScopedDoctorIds` / `tenantContext` / `authorizeResource` / `checarAcesso`), **não** de RLS. RLS protege apenas o acesso direto do browser (anon key).
- **Confused-deputy:** o backend valida `doctor_id`/`organization_id` contra a membership do `req.user` antes de qualquer query — nenhuma rota usa um id de tenant não validado numa query service-role. A expansão mantém essa regra.
- `scripts/migrate-token-encryption.js` usa `pg` direto (não service-role), só localhost.

## 6. Consultas diretas do frontend ao Supabase (anon key)

| local | query | RLS que protege | risco |
|---|---|---|---|
| `App.jsx:63` | `doctors.select('id').eq('owner_user_id', userId)` | `doctor_owns_own_row` | nenhum — só a própria clínica |
| `App.jsx:155/165` | `users.select('*').eq('id', session.user.id)` | `self_read_users` | nenhum — só o próprio perfil |
| `Conversas.jsx:31` | Realtime `channel('conversations-live').on(INSERT conversations)` | `conversations` **deny-all** | **nenhum evento chega** ao browser (canal inócuo) — recarga real vem de `/conversations` |

**Não há** escrita direta do frontend em nenhuma tabela de tenant. Tudo passa por `client.js` → API Express.

## 7. Canais Realtime

Um único: `conversations-live` (`Conversas.jsx`). Como `conversations` é deny-all para `authenticated`, o Postgres não entrega mudanças a esse canal. **Efeito prático hoje:** o `carregar()` no callback nunca dispara por Realtime; a tela depende de re-fetch manual/navegação. **Para a expansão:** se algum dia o Realtime de `conversations` for ligado, terá de ser com RLS por organização (`is_org_member` sobre `lead.organization_id`) — fora do escopo desta fase; registrado como pendência.

## 8. Webhooks

| webhook | resolução de tenant | confiável? |
|---|---|---|
| WhatsApp Cloud API | `value.metadata.phone_number_id` → `integrations.external_id` → `doctor_id` | ✅ servidor; assinatura `META_APP_SECRET` sobre `rawBody` |
| Pagar.me / Kiwify / Hotmart / Ticto | header `X-Prognexo-Webhook-Token` → `TokenLookup.blindIndex` → `webhook_token_lookup` → `doctor_id` (+ confirmação `timingSafeEqual`) | ✅ servidor (FASE 2.2) |

Nenhum webhook aceita `organization_id`/`doctor_id` do corpo. A expansão **não altera** a resolução de tenant dos webhooks; no máximo, após resolver `doctor_id`, deriva `organization_id` via `organization_doctor_map` para gravar nas colunas novas.

## 9. Integrações

- `integrations` (WhatsApp/gateways) e `google_tokens` — credenciais **cifradas em repouso** (FASE 2.2, `CredentialVault`). SELECT do browser **revogado** (0009).
- `GET /integrations` devolve só `*_configurado` (boolean) via `stripSecrets` — **nunca** token nem ciphertext.
- **Gap conhecido (herdado da FASE 2.1):** `Integrations.jsx` monta a URL de webhook de pagamento com `integ.webhook_token`, campo que a API não devolve desde o 0008 → a tela de gateway de pagamento não consegue exibir a URL. Tratado na ETAPA 7 desta fase (regeneração explícita + retorno único, sem reexposição).

## 10. Rotas que ainda NÃO usam `tenantContext`

`/conversations`, `/integrations`, `/knowledge-base`, `/bdr`, `/patients`, `/reports`, `/dashboard`, `/team`, `/doctors`, `/onboarding`, `/playground`, `/auth/google` (user-scoped), webhooks (ponte confiável), `/jobs` (global).

## 11. Lugares onde o tenant poderia vir do body — e por que não vem

Todas as rotas acima recebem `doctor_id` (body ou query) **mas** o validam contra o conjunto de doctors do `req.user` antes de qualquer operação. `organization_id`/`unit_id` só entram por header/query em `tenantContext` e são checados contra `memberships` ativas. Nenhum schema `zod` de POST inclui `organization_id`. **Conclusão:** a superfície de "tenant do body" é zero hoje; a expansão precisa manter isso (schemas `.strict()`, header-only para org/unit).

## 12. Fluxos que poderiam cruzar organizações acidentalmente

| fluxo | risco | mitigação atual / necessária |
|---|---|---|
| usuário multi-org (`MULTI` no seed) sem header | `tenantContext` retorna **409** `organization_selection_required` | ✅ já implementado; **frontend precisa do seletor** (ETAPA 4) |
| `platform_admin` com 1 membership | `tenantContext` escopa à org da membership, perde visão global sem header | documentar; header explícito habilita visão plataforma |
| webhook resolve `doctor_id` mas grava sem `organization_id` | linha nova fica sem tenant → invisível às policies org | migration 0010: trigger/backfill ou o próprio código do webhook deriva via map |
| `/jobs` cron | roda cross-tenant por design | **não** passar `attachTenantContext`; manter service-role sem escopo |
| `conversations`/`transactions`/`atendimentos` sem coluna própria | policy org depende de join a `leads`/`deals` | 0010 adiciona `organization_id` denormalizado + índice, OU policy via join (decidir na ETAPA 5) |
| `user_doctor_access` vs `memberships` | duas fontes de verdade de equipe | **aditivo**: `memberships` é canônico quando `TENANT_CORE_ENABLED=true`; `user_doctor_access` mantido para flag off. Cutover = fase futura |

## 13. Recomendação de escopo para a FASE 2.3

**Ordem de expansão (aditiva, atrás de `TENANT_CORE_ENABLED`):**

1. **0010 aditiva** — `organization_id` (nullable) + índice em: `conversations`, `knowledge_base`, `knowledge_chunks`, `ia_agentes_bdr`, `transactions`, `atendimentos`, `products`. `google_tokens` recebe `organization_id` nullable (derivado do map) só para relatórios. Backfill idempotente via `organization_doctor_map` + issues; **sem `NOT NULL`/constraint** nesta fase.
2. **Policies org aditivas** (OR com as legadas) para cada tabela acima — `organization_id is not null and is_org_member(organization_id)` — equivalentes às doctor-scoped porque o map é 1:1.
3. **`tenantContext` nas rotas LEGADAS** — trocar `getScopedDoctorIds(req.user)` por `scopedDoctorIds(req, getScopedDoctorIds)` e `checarAcesso` por `tenantAllowsDoctor`, exatamente como no corte vertical da FASE 2.1. INSERT grava `organization_id` do contexto.
4. **`X-Unit-Id`** — `resolveTenantContext` valida que o `unit_id` pertence a `unitIds` da membership; rejeita cross-unit.
5. **`GET /tenant/context`** (ETAPA 3) + **seletor no frontend** (ETAPA 4).
6. **ETAPA 7** — regeneração de `webhook_token` com retorno único.

**Fora do escopo (cutover definitivo / fase futura):**
- remover `user_doctor_access` / `doctor_id` / colunas plaintext de token;
- ligar `TENANT_CORE_ENABLED` em qualquer ambiente remoto;
- Realtime de `conversations` por organização;
- KMS.

**Bloqueadores de cutover registrados:** `user_doctor_access` como fonte de verdade da equipe; `/doctors` e `/team` expõem o modelo "doctor = clínica" que o frontend consome; `google_tokens` keyed por `user_id` (usuário pode ter memberships em N orgs — token do Google é do usuário, não da org).
