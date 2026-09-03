# 18 — FASE 2.1: Auditoria de compatibilidade (tenancy aditivo)

Branch `foundation/tenant-core`. Base backend `60e2bd8`, frontend `16ef8b9` (só auditoria).
**Nenhuma coluna/tabela removida. `doctor_id` preservado.**

## 1. Tabelas com `doctor_id` (tenant atual)

| Tabela | Como o tenant é resolvido hoje | Tenant-alvo | Estratégia de compat |
| --- | --- | --- | --- |
| `leads` | `doctor_id` direto | `organization_id` (+ `unit_id` opcional) | coluna nova `organization_id` nullable, backfill via `organization_doctor_map`; RLS por org OU por doctor (flag) |
| `deals` | **indireto**: `lead_id → leads.doctor_id` | idem, via `leads` | não ganha `organization_id` própria; RLS via join em `leads` |
| `events` | `doctor_id` direto | `organization_id` + `unit_id` | coluna nova; backfill |
| `campanhas` | `doctor_id` direto | `organization_id` | coluna nova; backfill |
| `conversations` | indireto: `lead_id → leads.doctor_id` | via `leads` | RLS via join |
| `atendimentos` | indireto: `lead_id → leads.doctor_id` | via `leads` | RLS via join |
| `integrations` | `doctor_id` direto | `organization_id` | coluna nova; backfill |
| `knowledge_base` | `doctor_id` direto | `organization_id` | coluna nova; backfill |
| `knowledge_chunks` | `doctor_id` direto | `organization_id` | coluna nova; backfill (fora do corte vertical 2.1) |
| `products` | `doctor_id` direto | `organization_id` | coluna nova; backfill (fora do corte 2.1) |
| `ia_agentes_bdr` | `doctor_id` (unique) | `organization_id` | fora do corte 2.1 |
| `user_doctor_access` | `user_id` + `doctor_id` | substituído por `memberships` + `membership_units` | **mantido**; `memberships` é derivado dele no backfill |

## 2. Colunas de vínculo com usuário

| Tabela.coluna | Papel | Ação FASE 2.1 |
| --- | --- | --- |
| `doctors.owner_user_id` | dono da clínica | → `memberships.role = organization_owner` |
| `user_doctor_access.(user_id, doctor_id)` | closer ↔ clínica | → `memberships.role = closer` + `membership_units` (unit default) |
| `leads.sdr_responsavel_id`, `deals.sdr_responsavel_id` | carteira do closer | **preservado** — continua sendo `user_id`; RLS de "carteira" mantida |
| `events.responsavel_id` | responsável pelo evento | **preservado** |
| `google_tokens.user_id` | dono do token Google | **preservado** (é por-usuário, não por-tenant) |
| `users.role` (`admin`/`doctor`/`closer`) | papel global legado | **preservado**; `admin` → `platform_admin` no novo modelo (não é membership) |

## 3. Rotas do backend — derivação de tenant

| Rota | Deriva tenant via | No corte vertical 2.1? |
| --- | --- | --- |
| `/leads` (GET/POST/PATCH) | `getScopedDoctorIds(req.user)` + `authorizeResource` | **SIM** |
| `/deals` (GET, PATCH `/:id/etapa`) | `getScopedDoctorIds` + `authorizeResource` (join `leads`) | **SIM** |
| `/events` (GET/POST/PATCH `/:id/status`) | `getScopedDoctorIds` + `authorizeResource` + `assertRelatedBelongs` | **SIM** |
| `/campanhas` (GET/POST/POST `/:id/enviar`) | `checarAcesso(req, doctor_id)` | **SIM** |
| `/conversations`, `/dashboard`, `/reports`, `/patients`, `/knowledge-base`, `/bdr`, `/team`, `/doctors`, `/integrations`, `/onboarding`, `/playground` | `getScopedDoctorIds` / `checarAcesso` / `resolveDoctorId` | **NÃO** (fases seguintes) |
| `/auth/google/*` | `req.user.id` (por-usuário) | não se aplica |

## 4. Queries Supabase do backend
Todas via **service-role** (`src/lib/supabase.js`) — bypassam RLS. A isolação hoje é 100% na aplicação (`getScopedDoctorIds`, `authorizeResource`). A FASE 2.1 **adiciona** RLS por org como 2ª barreira nas tabelas do corte vertical; o backend continua usando service-role, mas o resolvedor de contexto passa a ser a fonte única de `organization_id`.

## 5. Acessos diretos ao Supabase pelo FRONTEND (auditoria read-only)

| Local | Operação | Depende de tenant? | Impacto FASE 2.1 |
| --- | --- | --- | --- |
| `App.jsx:63` | `from('doctors').select('id').eq('owner_user_id', <self>)` — **read** | own doctor id | **mantido** (policy `doctor_owns_own_row`). Futuro: substituir por `/me/organizations`. |
| `App.jsx:155/165`, `Login.jsx:28` | `from('users').select('*').eq('id', <self>)` — **read** | próprio perfil | **mantido** (policy `self_read_users`) |
| `Conversas.jsx:31` | Realtime `postgres_changes` INSERT em `conversations` | nenhum (só dispara `carregar()`) | `conversations` é deny-all → **o browser já não recebe eventos**; callback continua chamando a API. Inofensivo. Documentado. |
| **nenhum** | write em `leads`/`deals`/`events`/`campanhas` | — | **o frontend NÃO escreve direto nessas tabelas** — todo write passa pela API Express (`client.js`). ⇒ **AR-2 pode ser corrigido com segurança** (revogar UPDATE amplo do PostgREST). |
| **nenhum** | read de `google_tokens` / `integrations` (colunas de token) | — | **o frontend NÃO lê tokens** (usa `/auth/google/status` e `/integrations` que já stripa). ⇒ **AR-3 containment é seguro**. |

## 6. Policies atuais
20 policies (baseline). Todas usam role `public`. Detalhe em `00-current-state-audit.md §2.4` e no baseline. Tabelas sem policy = deny-all: `products`, `deals`, `conversations`, `transactions`, `knowledge_chunks`, `ia_agentes_bdr`.

## 7. Funções SECURITY DEFINER
`is_admin()`, `is_doctor_owner(uuid)`, `user_has_doctor_access(uuid)` — **já endurecidas** na migration `0007` (`search_path = ''`, revoke `anon`). A `0008` adiciona `current_org()` / `is_org_member(uuid)` / `has_org_role(uuid, text[])` no mesmo padrão.

## 8. Webhooks — resolução de tenant
| Webhook | Resolve tenant por | Ação 2.1 |
| --- | --- | --- |
| WhatsApp POST | `phone_number_id` → `integrations.doctor_id` (`whatsapp.js:62,81`) | **preservado**; quando `integrations.organization_id` existir, resolver pelos dois (dual-read) |
| Pagamento (`paymentFactory`) | `X-Prognexo-Webhook-Token` → `integrations.webhook_token → doctor_id` (`salesWebhook.resolveDoctorFromToken`) | **preservado** |

## 9. Google tokens e integrações
- `google_tokens`: por-**usuário** (não por-tenant). Fora do modelo de org. Mantido.
- `integrations`: por-**doctor**. Ganha `organization_id` (backfill). Tokens: **AR-3 containment** nesta fase (revoke browser), cifra na 2.2.

## 10. Campanhas, IA, billing
- Campanhas: `doctor_id` → `organization_id` (no corte vertical).
- IA (`iaAgent`, `playground`, `knowledge_chunks`, `ia_agentes_bdr`): usa `doctor_id`; migração fora da 2.1.
- Billing (`doctors.plano/modulo/periodicidade/asaas_*`, `/planos`): **plano NÃO vira role**. `plano` continua em `doctors` (e no futuro numa tabela `subscriptions` por org). `memberships.role` é só autorização.

## 11. Dados que NÃO podem ser mapeados com segurança (ambiguidades)

| Situação | Por quê é ambíguo | Tratamento na 0008 |
| --- | --- | --- |
| `user_doctor_access` com o **mesmo `user_id` ligado a 2+ doctors** | qual organização é a "principal"? | cria **membership em cada org** (role `closer`), status `active`. Não é ambíguo — o usuário passa a ter múltiplas orgs e escolhe uma no login. |
| `doctors.owner_user_id` = **mesmo user_id dono de 2+ doctors** | idem | membership `organization_owner` em cada; múltiplas orgs. |
| `user_doctor_access` onde o `user_id` **também** é `owner_user_id` de outro doctor | papel conflitante entre orgs | ok — role por org: owner numa, closer noutra. |
| `doctors` com `owner_user_id` **NULL** | sem dono | cria a org, **NÃO cria membership**; registra em `tenant_backfill_issues` (motivo `orphan_doctor_no_owner`). |
| `users.role='closer'` **sem** nenhuma linha em `user_doctor_access` | closer sem clínica | **NÃO cria membership**; registra `closer_without_access`. |
| `user_doctor_access.user_id` **não existe** em `public.users` | FK órfã (dados legados) | pulado; registra `membership_user_missing`. |
| `users.role='admin'` | admin de plataforma | **NÃO vira membership**; marcado `platform_admins` (nova tabela) se existir, senão a role global `admin` continua governando via `is_admin()`. |

**Regra**: a 0008 **nunca escolhe um tenant "principal" silenciosamente**. Se não dá para mapear com certeza, não cria membership e grava o caso em `tenant_backfill_issues`.

## Matriz-resumo

| recurso | tenant atual | tenant alvo | estratégia compat | risco | teste |
| --- | --- | --- | --- | --- | --- |
| leads | `doctor_id` | `organization_id` (col nova, nullable) | dual: RLS por org (flag on) OU por doctor (flag off); map | médio (RLS dupla) | RLS: owner/closer/no-member/2-orgs/id-cross/payload-adulterado |
| deals | via `leads` | via `leads` | join em RLS | médio | RLS: closer x deal Org B (0 linhas) |
| events | `doctor_id` | `organization_id` + `unit_id` | col nova; map | médio | RLS + unit de outra org |
| campanhas | `doctor_id` | `organization_id` | col nova; map | médio | RLS + envio bloqueado cross-org |
| memberships | `user_doctor_access` + `doctors.owner_user_id` | `memberships` | backfill; ambiguidades → `tenant_backfill_issues` | alto (backfill) | idempotência; ambiguidade não cria membership |
| role | `users.role` | `memberships.role` | ambos coexistem; `admin` → `platform_admin` | médio | privilege escalation; role do body ignorado |
| AR-2 (closer/PostgREST) | `closer_updates_own_leads` amplo | UPDATE revogado + colunas permitidas | frontend não escreve direto → seguro | alto | closer altera campo permitido / bloqueia ia_score, doctor_id, org_id, owner |
| AR-3 (tokens) | policy ALL no browser | revoke colunas de token + view segura | frontend não lê tokens → seguro | alto | browser não lê token; view só retorna estado |
| feature flag | — | `TENANT_CORE_ENABLED=false` | dual-read/write documentado | baixo | flag false = comportamento atual; true = tenancy novo |
