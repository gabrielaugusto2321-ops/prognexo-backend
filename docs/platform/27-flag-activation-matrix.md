# FASE 2.9 — Matriz de flags: ativação, desligamento, rollback

Companion da auditoria `26-tenant-cutover-readiness-audit.md`. Descreve a
ordem segura de ligar/desligar as flags das FASES 2.1–2.8 e o que cada uma
exige antes de ser ligada.

> **Todas as flags nascem `false`.** Este documento é para o cutover LOCAL
> (ensaio). Nada aqui autoriza ativação remota.

---

## 1. Cadeia de dependências (imposta no boot)

```
TENANT_CORE_ENABLED
  └─ TEAM_MEMBERSHIPS_ENABLED
       └─ TEAM_INVITE_OUTBOX_ENABLED
            └─ TEAM_INVITE_EMAIL_DELIVERY_ENABLED   (+ RESEND_API_KEY + keyring)

TOKEN_ENCRYPTION_ENABLED            (+ keyring + active key + TOKEN_LOOKUP_HMAC_KEY)
  ├─ TOKEN_ENCRYPTION_DUAL_WRITE            (janela de migração)
  └─ TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ  (janela de migração)

PERSISTENT_JOB_QUEUE_ENABLED        (+ keyring + JOB_RUNNER_SECRET)
  └─ CAMPAIGN_JOB_QUEUE_ENABLED
       └─ USAGE_QUOTAS_ENABLED      (obrigatória junto com CAMPAIGN em staging/production)
```

Guardas de boot (`src/config/env.js`):

| Regra | Função | Erro |
|---|---|---|
| `TEAM_MEMBERSHIPS ⇒ TENANT_CORE` | `validateTenantFlagChain` | `Invalid tenant flag chain` |
| `TEAM_INVITE_OUTBOX ⇒ TEAM_MEMBERSHIPS` | `validateTenantFlagChain` | `Invalid tenant flag chain` |
| `TEAM_INVITE_EMAIL_DELIVERY ⇒ TEAM_INVITE_OUTBOX` | `validateTeamInviteOutbox` | `Invalid team-invite-outbox configuration` |
| `TEAM_INVITE_OUTBOX ⇒ keyring + active key` | `validateTeamInviteOutbox` | idem |
| `TEAM_INVITE_EMAIL_DELIVERY ⇒ RESEND_API_KEY` | `validateTeamInviteOutbox` | idem |
| `TOKEN_ENCRYPTION_DUAL_WRITE ⇒ TOKEN_ENCRYPTION_ENABLED` | `validateTokenEncryption` | `Invalid token-encryption configuration` |
| `TOKEN_ENCRYPTION_ENABLED ⇒ keyring + active key + HMAC` | `validateTokenEncryption` | idem |
| `CAMPAIGN_JOB_QUEUE ⇒ PERSISTENT_JOB_QUEUE` | `validatePersistentJobs` | `Invalid persistent-jobs configuration` |
| `CAMPAIGN_JOB_QUEUE ⇒ USAGE_QUOTAS` (staging/production) | `validatePersistentJobs` | idem |
| `PERSISTENT_JOB_QUEUE ⇒ keyring + JOB_RUNNER_SECRET` | `validatePersistentJobs` | idem |

A fila de jobs **não** depende de `TENANT_CORE_ENABLED` no boot: a RPC
`job_enqueue` exige `organization_id` (exceto `job_type='system.maintenance'`,
allowlist no CHECK), então a isolação já é estrutural.

---

## 2. Pré-requisitos por flag

| Flag | Migration | Backfill / dados exigidos antes de ligar | Pode ligar isolada? |
|---|---|---|---|
| `TENANT_CORE_ENABLED` | 0008 + 0010 | `organizations`, `units`, `memberships` (1 ativa por usuário), `organization_doctor_map` (1 linha por doctor). Sem isso: usuário sem membership → 403; multi-org sem header → 409. | Sim (base da cadeia) |
| `TEAM_MEMBERSHIPS_ENABLED` | 0012 | memberships reconciliadas com `user_doctor_access` (relatório `team_backfill_reconciliation`, sem divergência que afete autorização). | Não — exige `TENANT_CORE` |
| `TEAM_INVITE_OUTBOX_ENABLED` | 0013 | keyring AES válido (`TOKEN_ENCRYPTION_KEYRING` + `TOKEN_ENCRYPTION_ACTIVE_KEY`), mesmo com `TOKEN_ENCRYPTION_ENABLED=false`. | Não — exige `TEAM_MEMBERSHIPS` |
| `TEAM_INVITE_EMAIL_DELIVERY_ENABLED` | — | `RESEND_API_KEY`. Local: usar sempre o adapter fake (nunca ligar delivery real). | Não — exige `OUTBOX` |
| `TOKEN_ENCRYPTION_ENABLED` | 0009 + 0011 | keyring + active key + `TOKEN_LOOKUP_HMAC_KEY` (≥32 bytes). Para não perder credenciais existentes: ligar primeiro `DUAL_WRITE=true` + `ALLOW_PLAINTEXT_READ=true`, rodar backfill de ciphertext, depois estreitar. | Sim (independente da cadeia de tenancy) |
| `PERSISTENT_JOB_QUEUE_ENABLED` | 0014 | keyring + `JOB_RUNNER_SECRET`. | Sim |
| `USAGE_QUOTAS_ENABLED` | 0014 | `usage_limits` por organização (senão: sem limite configurado ⇒ comportamento conforme contrato da 2.8 — reserva permitida, sem teto). | Sim (mas só tem efeito com `CAMPAIGN_JOB_QUEUE`) |
| `CAMPAIGN_JOB_QUEUE_ENABLED` | 0014 | **`scripts/check-campaigns-without-org.js` → exit 0** (nenhuma campanha sem `organization_id`); senão o disparo devolve `409 tenant_backfill_required`. | Não — exige `PERSISTENT_JOB_QUEUE` |

---

## 3. Ordem de ativação (cutover completo)

1. Aplicar todas as migrations até a 0014 (baseline → última).
2. Backfill de tenancy: `organizations`/`units`/`memberships`/
   `organization_doctor_map` para todo doctor existente.
3. **`TOKEN_ENCRYPTION_ENABLED`** (com `DUAL_WRITE` + `ALLOW_PLAINTEXT_READ`),
   backfill de ciphertext das integrações, depois desligar `DUAL_WRITE`/
   `ALLOW_PLAINTEXT_READ`. *(Independente — pode vir antes ou depois do passo 4.)*
4. **`TENANT_CORE_ENABLED`**. Validar: login, `/tenant/context`, seleção de
   organização, 20 fluxos (ETAPA 7).
5. **`TEAM_MEMBERSHIPS_ENABLED`**. Validar equipe (listar/adicionar/mudar
   papel/suspender/remover) via memberships; `user_doctor_access` como ponte
   para `role='closer'`.
6. **`PERSISTENT_JOB_QUEUE_ENABLED`** + **`USAGE_QUOTAS_ENABLED`**. Configurar
   `usage_limits` por org.
7. `check-campaigns-without-org.js` → exit 0. Então **`CAMPAIGN_JOB_QUEUE_ENABLED`**.
8. **`TEAM_INVITE_OUTBOX_ENABLED`** (+ delivery só quando `RESEND_API_KEY`
   estiver pronta; local = adapter fake).

Regra transversal: **nenhum fluxo novo pode cair silenciosamente no legado
quando a flag dele está ligada** (ETAPA 5 garante isso com 403/404/409).

**platform_admin com `TENANT_CORE_ENABLED=true`:** em qualquer rota
tenant-scoped, precisa mandar `X-Organization-Id` (senão 409
`organization_selection_required`) e fica limitado àquela organização —
não existe "modo global implícito". Acesso global só nos endpoints
explicitamente globais: `POST /doctors` e `GET /tenant/shadow-metrics`.
Se a org selecionada não tiver `organization_doctor_map`, qualquer rota
tenant-scoped responde 409 `tenant_backfill_required` — rode
`check-tenant-cutover-readiness.js` (`doctors_sem_map`) antes de ligar.

---

## 4. Ordem de desligamento (rollback de flags)

Inverso da ativação — desligar de cima para baixo na cadeia:

1. `CAMPAIGN_JOB_QUEUE_ENABLED` → volta ao envio de campanha legado
   (`processarEnvioCampanha`, 202 imediato). Jobs `campaign.*` já enfileirados
   ficam órfãos na tabela (não são drenados) — aceitável no ensaio; drenar
   antes com o worker se quiser fila limpa.
2. `USAGE_QUOTAS_ENABLED` → reservas deixam de ser exigidas; sweep de
   reservas órfãs continua seguro.
3. `PERSISTENT_JOB_QUEUE_ENABLED` → `/jobs/campaign-outbox` volta a 404.
4. `TEAM_INVITE_OUTBOX_ENABLED` → `/team/invitations` volta a 404; convites
   `pending`/`queued` não são mais processados (expiram pela sweep).
5. `TEAM_MEMBERSHIPS_ENABLED` → `/team` volta 100% a `user_doctor_access`.
6. `TENANT_CORE_ENABLED` → `attachTenantContext` vira no-op; todas as rotas
   voltam a `getScopedDoctorIds` legado. `X-Organization-Id` é ignorado.
7. `TOKEN_ENCRYPTION_ENABLED` → **só desligar com `ALLOW_PLAINTEXT_READ=true`
   e plaintext ainda gravado** (ou nunca ter parado o `DUAL_WRITE`), senão
   credenciais só-ciphertext ficam ilegíveis. Este é o único desligamento
   que exige janela de migração reversa.

Nenhum desligamento apaga dados. As tabelas novas permanecem; só param de
ser consultadas pelo caminho de request.

---

## 5. Combinações inválidas (o boot recusa)

| Combinação | Resultado |
|---|---|
| `TEAM_MEMBERSHIPS_ENABLED=true`, `TENANT_CORE_ENABLED=false` | boot cai (`Invalid tenant flag chain`) |
| `TEAM_INVITE_OUTBOX_ENABLED=true`, `TEAM_MEMBERSHIPS_ENABLED=false` | boot cai (`Invalid tenant flag chain`) |
| `TEAM_INVITE_EMAIL_DELIVERY_ENABLED=true`, `TEAM_INVITE_OUTBOX_ENABLED=false` | boot cai |
| `CAMPAIGN_JOB_QUEUE_ENABLED=true`, `PERSISTENT_JOB_QUEUE_ENABLED=false` | boot cai |
| `CAMPAIGN_JOB_QUEUE_ENABLED=true`, `USAGE_QUOTAS_ENABLED=false` (staging/production) | boot cai |
| `PERSISTENT_JOB_QUEUE_ENABLED=true` sem keyring/`JOB_RUNNER_SECRET` | boot cai |
| `TOKEN_ENCRYPTION_ENABLED=true` sem keyring/active key/HMAC | boot cai |
| `TOKEN_ENCRYPTION_DUAL_WRITE=true`, `TOKEN_ENCRYPTION_ENABLED=false` | boot cai |

---

## 6. Flags que podem ser ativadas isoladamente

- **`TENANT_CORE_ENABLED`** — base da cadeia; só exige o backfill de tenancy.
- **`TOKEN_ENCRYPTION_ENABLED`** — ortogonal à tenancy; exige só material
  criptográfico + janela de migração.
- **`PERSISTENT_JOB_QUEUE_ENABLED`** — ortogonal; exige só keyring +
  `JOB_RUNNER_SECRET`. Sem `CAMPAIGN_JOB_QUEUE` nenhum job de campanha é
  enfileirado (a fila fica ociosa, pronta para futuros produtores).
- **`USAGE_QUOTAS_ENABLED`** — pode ligar sozinha, mas só tem efeito quando
  algum produtor (hoje: `CAMPAIGN_JOB_QUEUE`) chama `usage_reserve`.

Todas as demais exigem a de baixo na cadeia.

## 7. Flags que exigem migration + backfill antes de ligar

| Flag | Migration | Backfill |
|---|---|---|
| `TENANT_CORE_ENABLED` | 0008, 0010 | organizations/units/memberships/organization_doctor_map |
| `TEAM_MEMBERSHIPS_ENABLED` | 0012 | reconciliação memberships × user_doctor_access |
| `TOKEN_ENCRYPTION_ENABLED` | 0009, 0011 | ciphertext das credenciais existentes (via DUAL_WRITE) |
| `CAMPAIGN_JOB_QUEUE_ENABLED` | 0014 | `organization_id` em todas as campanhas (`check-campaigns-without-org.js` = exit 0) |
| `USAGE_QUOTAS_ENABLED` | 0014 | `usage_limits` por organização (opcional, mas recomendado) |

`TEAM_INVITE_OUTBOX_ENABLED` (0013) e `PERSISTENT_JOB_QUEUE_ENABLED` (0014)
exigem a migration mas **não** exigem backfill de linhas — só material
criptográfico/segredo.
