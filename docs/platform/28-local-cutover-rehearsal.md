# FASE 2.10 — Ensaio LOCAL do cutover multitenant + fechamento do readiness gate

**Branch:** `foundation/tenant-cutover-readiness`
**Base backend:** `7e1234a48154984663652931ee6a66c02c4a5aed`
**Base frontend:** `afb097c8e60604778dd3ff1b06aff364317bcd8a`
**Objetivo:** provar LOCALMENTE, com dados 100% sintéticos, que o Prognexo
pode ativar o novo tenancy progressivamente sem perder dados, misturar
organizações, criar acesso indevido, quebrar fluxos existentes, depender de
fallback silencioso por `doctor_id`, expor tokens, ou disparar
WhatsApp/Meta/e-mail/IA/pagamento reais.
**Fora de escopo:** push/deploy/staging/produção, Supabase remoto,
`supabase link`/`db push`, remoção de `doctor_id`/`user_doctor_access`,
`NOT NULL` em `organization_id`, mudar default de flags.

---

## 1. Preflight (ETAPA 1)

| Item | Estado |
|---|---|
| backend branch / HEAD | `foundation/tenant-cutover-readiness` @ `7e1234a…` — working tree limpo |
| frontend branch / HEAD | `foundation/tenant-cutover-readiness` @ `afb097c8…` — working tree limpo |
| Supabase remoto vinculado | não (`git remote` só `origin` GitHub; sem `supabase/.temp/project-ref`) |
| Docker / WSL | operantes (engine 29.7.2, WSL responsivo) |
| Supabase local | subido (`-x studio -x imgproxy -x edge-runtime -x logflare -x vector -x pooler`; volume de storage stale removido antes) |
| `supabase db reset` | baseline → 0003…0014 → `seed.sql` — 13 entradas em `schema_migrations`, 37 tabelas, sem skip (README.md ignorado corretamente) |

---

## 2. As quatro pendências do inventário (ETAPA 2)

O `scripts/check-tenant-cutover-readiness.js` contra o seed base retorna
**exit 2**. Origem, impacto, classe e tratamento:

### 2.1 `usuarios_sem_membership_ativa` — 1 linha (`…0000c3` "Closer Orfao")

| | |
|---|---|
| **Origem** | `supabase/seed.sql` insere o usuário `closer` **sem** `user_doctor_access`. O backfill 0008 não cria membership (não há doctor vinculado). Comentário no seed: *"closer legado SEM user_doctor_access -> backfill registra 'closer_without_access'"*. |
| **Uso nos testes** | `test/rls/tenant-core.rls.test.js` usa esse UUID (`ORFAO`) para provar que um usuário sem membership recebe **403 `no_active_membership`** em `resolveTenantContext`. |
| **Impacto no cutover** | Com `TENANT_CORE_ENABLED=true`, esse usuário não consegue usar rota tenant-scoped nenhuma (403). Não vaza dados, não mistura org — só não tem acesso. |
| **Classe** | **A** (fixture adversarial necessária) **+ D** (num cutover real, decidir: reativar com membership ou encerrar a conta). |
| **Tratamento no cenário cutover-ready** | Regra automática explícita = **desativar** (`users.ativo = false`). Conta sem organização não acessa tenant nenhum; desativar é a ação segura, reversível (`db reset` restaura) e não presume qual organização seria a "certa" (isso é decisão humana). **Não** cria membership. |
| **Prova** | `check-tenant-cutover-readiness` filtra `ativo=true` — após desativar, a checagem fica `[ok]` legitimamente (o contrato dela é "usuário ATIVO sem membership"). Não é mascaramento. |

### 2.2 `usuarios_multi_org` — 1 linha (`…0000c2` "Closer Multi")

| | |
|---|---|
| **Origem** | `seed.sql` dá `user_doctor_access` do "Closer Multi" às **duas** clínicas. Backfill 0008 → 2 memberships ativas (Org A + Org B). |
| **Uso nos testes** | `MULTI` em `tenant-context.rls`/`tenant-endpoint`/`tenant-platform-admin` — prova **409 `organization_selection_required`** sem header e escopo correto com header. |
| **Impacto no cutover** | **Nenhum impedimento técnico.** É um estado de negócio válido: o usuário pertence a 2 clínicas e escolhe uma por sessão via `X-Organization-Id`. O backend FASE 2.9 já **exige** essa seleção (409 sem ela); o frontend só auto-seleciona quando `length === 1`. |
| **Classe** | **A** (fixture adversarial) — e um estado **suportado** de produção. |
| **Tratamento** | **Preservado como está.** O readiness check foi ajustado: `usuarios_multi_org` passa de **BLOQUEADOR** → **AVISO** (`severity: 'warning'`) — reportado, com contagem e UUID, mas **não** derruba para exit 2. Isto não "esconde" nada: multi-org não é um problema, e o check continua estrito para todo impedimento técnico real. Testes provam que a seleção continua obrigatória e que nada escolhe "a primeira org". |

### 2.3 `memberships_ativas_sem_unidade` — 2 linhas (as 2 `organization_owner`)

| | |
|---|---|
| **Origem** | O backfill 0008 cria a membership de owner a partir de `doctors.owner_user_id`, mas **não** a vincula a `membership_units` (só as memberships derivadas de `user_doctor_access` de closer recebem unidade). Cada org do seed tem 1 unidade ativa e um `organization_doctor_map.default_unit_id`. |
| **Impacto no cutover** | Hoje `X-Unit-Id` é opcional (`resolveTenantContext` só valida se enviado). Uma membership sem unidade funciona para operações org-scoped. Mas o modelo-alvo espera toda membership ativa com pelo menos uma unidade — é lacuna de completude de dados. |
| **Classe** | **C** (migrável automaticamente). |
| **Tratamento** | O prep script vincula cada membership ativa sem unidade à `organization_doctor_map.default_unit_id` da org (fallback: 1ª unidade ativa). Idempotente (`upsert ... ignoreDuplicates`). |

### 2.4 `tokens_plaintext_restantes` — 2 linhas (`…061a`, `…061b`)

| | |
|---|---|
| **Origem** | `seed.sql` insere `integrations.access_token`/`webhook_token` como **texto puro** (`'segredo-A'`, `'wht-A'`, …) — reflete o modelo atual, pré-FASE 2.2. A migration 0009 (`token_encryption`) existe mas o seed não popula ciphertext. |
| **Uso nos testes** | `test/rls/token-encryption.rls.test.js` e `test/token-encryption-integration.test.js` cobrem os dois modos (plaintext legado e ciphertext). O plaintext no seed é a fixture do modo legado. |
| **Impacto no cutover** | Só relevante quando `TOKEN_ENCRYPTION_ENABLED=true`. Com a flag ligada e `DUAL_WRITE=false`, credenciais só-plaintext não são lidas — a integração pararia de funcionar. |
| **Classe** | **C** (migrável automaticamente, pelo mecanismo da FASE 2.2). |
| **Tratamento** | O prep script, para cada integração com plaintext, chama `CredentialVault.buildIntegrationCredentialPatch({ id, doctorId, gateway, values })` (o **mesmo** builder de produção) → grava `*_encrypted` + `webhook_token_lookup` + `token_encryption_migrated_at`, e então **zera** as colunas plaintext (migração concluída). **Nunca imprime plaintext nem ciphertext** — o relatório traz só contagem + UUID da integração. AAD ligada a `doctor:<id>` — sem cross-tenant. |

### 2.5 Resumo

| Pendência | Classe | Bloqueia? | Ação no cenário cutover-ready |
|---|---|---|---|
| conta órfã `…c3` | A + D | sim (BLOQUEADOR) | desativar (`ativo=false`) — regra automática explícita |
| multi-org `…c2` | A / suportado | **não** (AVISO) | preservar; provar seleção obrigatória |
| 2 owner-memberships sem unidade | C | sim (BLOQUEADOR) | vincular à unidade default da org |
| 2 integrations plaintext | C | sim (BLOQUEADOR) | cifrar via FASE 2.2 + zerar plaintext |

---

## 3. Perfil de dados cutover-ready (ETAPA 3)

As fixtures adversariais **continuam** em `supabase/seed.sql` — nada foi
enfraquecido. O cenário cutover-ready é produzido por um passo **separado e
explícito**:

**`scripts/prepare-cutover-ready-scenario.js`** — roda DEPOIS de
`db reset` + seed base. Idempotente. Requisitos atendidos:

- **`guardWriteEnvironment`**: só `APP_ENV` ∈ {development, test} **e**
  `SUPABASE_URL` localhost/127.0.0.1. Recusa host remoto e qualquer outro
  `APP_ENV` **antes** de criar cliente/conexão.
- não contém dado real; cria/ajusta só os dados sintéticos documentados aqui.
- não apaga fixture nenhuma (só `update`/`upsert`).
- toda membership ativa fica com unidade válida.
- conta órfã → regra explícita `deactivate`.
- usuário multi-org **preservado** (2 memberships ativas) — o script nunca
  escreve na tabela `memberships`.
- tokens plaintext → cifrados com o mecanismo da FASE 2.2; plaintext zerado;
  **nada de plaintext/ciphertext na saída**.
- idempotente (2ª/3ª execução: 0 mudanças).
- relatório: só contagens + UUIDs técnicos.

Uso:
```
APP_ENV=development \
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_SERVICE_ROLE_KEY=<local> \
TOKEN_ENCRYPTION_KEYRING='{"v1":"<32 bytes base64>"}' \
TOKEN_ENCRYPTION_ACTIVE_KEY=v1 \
TOKEN_LOOKUP_HMAC_KEY=<32 bytes base64> \
node scripts/prepare-cutover-ready-scenario.js
```

Testes: `test/prepare-cutover-ready-scenario.test.js` (12 casos — guarda de
ambiente, caminho feliz, idempotência, preservação de multi-org/platform_admin,
AAD por doctor, saída sem segredo).

---

## 4. Readiness check — antes / depois (ETAPA 4)

Contra 127.0.0.1, `APP_ENV=development`, service_role local:

### Antes (seed adversarial base)
```
[BLOQUEADOR] usuarios_sem_membership_ativa (1): 00000000-0000-4000-8000-0000000000c3
[AVISO]      usuarios_multi_org (1): 00000000-0000-4000-8000-0000000000c2
[BLOQUEADOR] memberships_ativas_sem_unidade (2): <2 uuids de membership>
[BLOQUEADOR] tokens_plaintext_restantes (2): 00000000-0000-4000-8000-00000000061a, …061b
BLOQUEADORES ENCONTRADOS.  EXIT 2
```

### Depois (`prepare-cutover-ready-scenario.js`, idempotente 3×)
```
prep run 1: memberships c/ unidade: 2 | órfãs desativadas: 1 | integrações cifradas: 2 | multi-org preservados: 1
prep run 2: 0 | 0 | 0 | 1
prep run 3: 0 | 0 | 0 | 1
```
```
[ok] usuarios_sem_membership_ativa
[AVISO] usuarios_multi_org (1): 00000000-0000-4000-8000-0000000000c2
[ok] memberships_ativas_sem_unidade
[ok] tokens_plaintext_restantes
PRONTO: nenhum bloqueador. 1 aviso operacional — não impede o cutover.  EXIT 0
```

Estado no banco após a preparação (verificado por `pg`):
`integrations.access_token`/`webhook_token` = NULL, `*_encrypted` presente,
`webhook_token_lookup` presente; `users.…c3.ativo` = false; as 5 memberships
ativas com `membership_units` ≥ 1.

O **cenário adversarial** permanece válido: um novo `db reset` restaura o seed
base (exit 2), e os testes de RLS que dependem de `ORFAO`/`MULTI`/plaintext
continuam verdes (rodam contra o seed base, não contra o cenário preparado).

---

## 5. Ensaio de ativação das flags (ETAPA 5)

`test/rehearsal-flag-ladder.test.js` — para cada estado da escada de
`docs/platform/27-flag-activation-matrix.md`, sobe o app local e roda os smoke
tests autenticados com usuários sintéticos. Provedores externos
(`whatsapp.js`, `emailAdapter.js`, `iaAgent.js`) são `vi.mock`ados; a lógica
de tenancy roda de verdade (mesmo `resolveTenantContext`/`scopedDoctorIds`).

| # | Estado | Flags | Boot | Smoke |
|---|---|---|---|---|
| 1 | todas off | — | ✅ | legado: multi-org 200, header ignorado, CRUD ok |
| 2 | tenant core | `TENANT_CORE_ENABLED` | ✅ | multi-org **409**, seleção → escopo certo, org alheia **403**, platform_admin **409** sem seleção |
| 3 | tenancy + rotas | idem 2 (`TENANT_CORE` cobre os 13 routers) | ✅ | idem 2 |
| 4 | team memberships | `+TEAM_MEMBERSHIPS_ENABLED` | ✅ | `/team/invitations` **404** (outbox off); equipe via memberships |
| 5 | convites/outbox | `+TEAM_INVITE_OUTBOX_ENABLED` | ✅ | `/team/invitations` existe (≠404); adapter fake |
| 6 | jobs + quotas | `+PERSISTENT_JOB_QUEUE +USAGE_QUOTAS +CAMPAIGN_JOB_QUEUE` | ✅ | `POST /campanhas/:id/enviar` → **202 + job_id**, **zero WhatsApp** na request |
| 7 | shadow reads | `+TENANT_SHADOW_READ_ENABLED` | ✅ | smoke tenancy inalterado; contadores em processo |
| 8 | final staging | 5+6+7 combinados | ✅ | matriz completa verde |

Smoke por estado (10 asserts): `/health` 200 · `/tenant/context` sem token,
sem auto-seleção com >1 org · owner GET /leads · multi-org sem seleção 409 (ON)
/ 200 (OFF) · seleção correta → escopo certo · org alheia 403 (ON) · platform_admin
conforme regra · CRUD leads/deals/events/conversations no tenant certo ·
`/integrations` só status, nunca token · nenhuma chamada externa real.

Resultado: **82/82** (8 estados × ~10 + 2 extras).

> Cobertura profunda de cada vertical continua nas suítes dedicadas
> (`campaigns-job-queue` 26, `team-invitations-api` 12, `team-api` 33, RLS
> reais) — a escada aqui prova que **cada degrau sobe e o núcleo de tenancy
> se comporta** em todos eles.

## 6. Shadow-read e compatibilidade (ETAPA 6)

Verificação SQL direta contra o **cenário cutover-ready preparado** (após
`db reset` + `prepare-cutover-ready-scenario.js`):

| Invariante | Resultado |
|---|---|
| organizações ativas sem `organization_doctor_map` (gap) | **0** |
| `leads` com `organization_id` ≠ org do doctor (via map) | **0** |
| `events` idem | **0** |
| `campanhas` idem | **0** |
| `integrations` idem | **0** |
| shadow-read `onlyMembership` (doctor que só o contexto novo enxerga) | **0** |
| shadow-read `onlyLegacy` (usuários ativos — doctor que só o legado enxerga) | **0** |
| memberships suspensas | 0 (nenhuma para vazar) |
| contas órfãs **ativas** (sem membership, não platform_admin) | **0** (a órfã foi desativada) |

`doctor_id` e `organization_id` **convergem** perfeitamente; nenhuma rota
seleciona o primeiro tenant (testes da ETAPA 5 provam 409); usuário suspenso
não acessa (testes `tenant-endpoint`/`rehearsal-flag-ladder`); frontend continua
enviando `X-Organization-Id` só do `tenantSelection` (testes frontend); legado
funciona com flags off e o novo com flags on (ETAPA 5, estados 1 vs 2–8).
Contadores do shadow-read em processo: `test/tenant-shadow-read.test.js` (11).

## 7. Frontend (ETAPA 7)

Interface **não redesenhada**. Frontend `afb097c8…` sem alteração de fonte —
só um arquivo de teste novo (`test/tenant-cutover-frontend.test.mjs`, `node
--test`, sem dependência nova).

| Requisito | Prova |
|---|---|
| 1 org → entra direto | `App.jsx` adota `suggested_organization_id` **só** quando `orgs.length === 1`; `tenantSelection.needsSelection([A], null) === false` |
| multi-org → precisa selecionar | `needsSelection([A,B], null) === true` → UI bloqueia telas; backend 409 |
| troca de organização limpa estado anterior | `setOrganizationId` zera `unit_id`; membership inválida → `tenantSelection.clear()` |
| nenhuma requisição protegida antes da seleção | `needsSelection` bloqueia a UI; 409 do backend é defesa em profundidade |
| recarrega no tenant certo | `client.js` injeta `tenantSelection.headers()` em toda request autenticada |
| 403/409 tratado sem loop | `client.js` → `ApiError.isTenantError` (códigos `organization_selection_required`, `no_membership_for_org`, `unit_not_in_organization`) |
| nenhum token no browser | `tenantSelection` grava só `pgx.tenant.organization_id`/`unit_id`; `query.js` descarta authority keys; `AceitarConvite` usa client isolado, token_hash nunca em storage |
| Meta / Embedded Signup intacto | `src/pages/Integrations.jsx` inalterado; nenhum arquivo de frontend de fonte tocado nesta fase |

Frontend: **51 + 8 = 59 testes** verdes; `vite build` OK.

## 8. Revisão adversarial (ETAPA 8)

Nenhum código de produção mudou na FASE 2.10 (só docs + scripts locais +
testes). Vetores revistos contra o `prepare-cutover-ready-scenario.js` e o
split de severidade do readiness check:

| Vetor | Avaliação |
|---|---|
| cross-tenant write | prep vincula unidade só dentro da própria org (`defaultUnitByOrg.get(m.organization_id)`); cifra com AAD `doctor:<row.doctor_id>`. Teste: `i1:docA`, `i2:docB` — nunca cruzado |
| confused deputy / mass assignment | prep monta patches explícitos, não recebe input externo; nunca escreve em `memberships` |
| bypass por `doctor_id` legado | n/a — prep não toca auth/rotas |
| JWT claims forjadas | n/a |
| memberships suspensas | prep filtra `status='active'`; suspensa continua sem unidade (sem acesso de qualquer forma) |
| multi-org sem seleção | prep **preserva** multi-org, nunca escolhe org; readiness = AVISO, não bloqueia; ETAPA 5 prova 409 |
| platform_admin | prep pula `platform_admins` na varredura de órfãos; teste: `padm` continua ativo |
| exposição de tokens | prep nunca loga plaintext/ciphertext — só contagem + UUID; teste bloqueia `segredo-\|wht-\|ENC(\|LOOKUP(` na saída |
| fallback inseguro | severidade: multi-org vira AVISO (estado suportado, backend força 409); **todo** impedimento técnico continua BLOQUEADOR |
| concorrência / idempotência | prep idempotente (3× = 0 mudanças): `upsert ignoreDuplicates` p/ unidade, `update … eq('ativo',true)` p/ órfão, loop de cifra filtra `access_token.not.is.null` |
| flags em combinações perigosas | prep usa `__setCryptoStateForTests({ENABLED:true, DUAL_WRITE:false, ALLOW_PLAINTEXT_READ:false})` — o modo mais estrito; não altera env do processo nem flags do app |
| logs com PII/segredos | relatório = contagens + UUIDs sintéticos |
| comportamento após reinício | `db reset` restaura o seed base; re-run do prep é no-op |

**Achados confirmados:** nenhum que exija correção de produção. Ajustes desta
rodada: (1) `usuarios_multi_org` reclassificado BLOQUEADOR→AVISO com
justificativa e testes; (2) saída limpa dos scripts CLI no Windows
(`process.exitCode` + timer unref em vez de `process.exit()` abrupto — evitava
`Assertion failed` em `src/win/async.c` ao colidir com o teardown do socket
do supabase-js).

## 9. Validação final (ETAPA 9)

| Gate | Resultado |
|---|---|
| 2 suítes backend completas, serializadas, **sem retry** | RUN 1 `2026-09-06 02:26` → **571/571, 41 arquivos**; RUN 2 `02:30` → **571/571, 41 arquivos**. 0 falha, 0 skip, 0 timeout |
| RLS reais **sem skip** | 8 suítes → **179/179** (`persistent-jobs-and-quotas` 24 · `team-invitations` 26 · `team-memberships` 42 · `tenant-core` 32 · `tenant-expansion` 12 · `tenant-isolation` 29 · `token-encryption` 7 · `webhook-token-lifecycle` 7) |
| Frontend `npm test` | **59/59** (51 + 8 novos) |
| Frontend `vite build` | ✅ built in 9.21s |
| Backend lint (`check-security-patterns`) | passou, **63 arquivos** (nenhum `src/` tocado na fase) |
| `node --check` (todos `.js`/`.mjs` M/??) | OK |
| `npm audit` backend / frontend | backend **7 moderate** pré-existentes; frontend **1 moderate + 1 high** pré-existentes — **0 dependência nova** |
| secret scan (diff + arquivos novos) | LIMPO |
| `git diff --check` | limpo (só avisos CRLF) |
| migrations originais vs cópias CLI | 12 pares (0003–0014) **byte-idênticos** (0001/0002 são pré-baseline, dobrados no `00000000000000_baseline.sql`). FASE 2.10 **não adicionou migration** |
| chamadas externas reais | zero — `whatsapp.js`/`emailAdapter.js`/`iaAgent.js` `vi.mock`ados nos smokes; nenhuma chave real de provedor |
| readiness antes/depois (execução final `02:4x`) | ANTES `exit 2` (3 bloqueadores + 1 aviso) → prep `exit 0` → DEPOIS `exit 0` "PRONTO: nenhum bloqueador. 1 aviso operacional" |
| Supabase local | `supabase stop` → `{"backup":true}`; **0 containers**, nenhuma porta escutando, 0 processos vite |

### Contagem de testes

| | FASE 2.9 (base) | FASE 2.10 | Total |
|---|---|---|---|
| Backend | 476 | +95 (`rehearsal-flag-ladder` 82 · `prepare-cutover-ready-scenario` 12 · `check-tenant-cutover-readiness` +1) | **571** |
| Frontend | 51 | +8 (`tenant-cutover-frontend`) | **59** |

### Arquivos da FASE 2.10

**Backend — 2 modificados:** `scripts/check-tenant-cutover-readiness.js`
(split BLOQUEADOR/AVISO + saída limpa no Windows), `test/check-tenant-cutover-readiness.test.js`.
**Backend — 4 novos:** `docs/platform/28-local-cutover-rehearsal.md`,
`scripts/prepare-cutover-ready-scenario.js`,
`test/prepare-cutover-ready-scenario.test.js`, `test/rehearsal-flag-ladder.test.js`.
**Frontend — 1 novo (só teste):** `test/tenant-cutover-frontend.test.mjs`.
**Nenhum código de produção alterado. Nenhuma migration/SQL/RPC. Meta intacta.**

### Recomendação

**PRONTO PARA COMMIT** (local, backend + o teste do frontend). O readiness gate
fecha: cenário adversarial base = `exit 2` (fixtures intactas, RLS 179/179);
cenário cutover-ready preparado = `exit 0` (0 bloqueadores, 1 aviso operacional
de multi-org, que é estado suportado). A escada de 8 estados de flags sobe
inteira com o núcleo de tenancy correto e sem fallback silencioso por
`doctor_id`.

### Próximo gate

Ativação em **staging** (fora do escopo local): aplicar as migrations 0008–0014
no ambiente de staging, rodar `check-tenant-cutover-readiness.js` com
`APP_ENV=staging` + `ALLOW_REMOTE_STAGING_READ=true` contra o Supabase de
staging, backfill dos bloqueadores reais que aparecerem, e então subir a
escada de flags de `27-flag-activation-matrix.md` uma a uma com verificação
entre cada degrau.
