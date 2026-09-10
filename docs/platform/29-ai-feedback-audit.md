# FASE 3.3A — Feedback humano da Auditoria de IA

**Branch:** `fix/ai-audit-feedback` (backend de `5c1006f`, frontend de `e33dbd6`).
Correção definitiva do bug pré-existente: a tela Auditoria envia uma avaliação
de conversa (`bom` / `ruim`), mas o backend respondia **400** e nada persistia.

---

## 1. Diagnóstico (com evidência)

| # | Pergunta | Evidência | Conclusão |
|---|---|---|---|
| 1 | `feedback_ia` existe no schema real? | `supabase/migrations/00000000000000_baseline.sql` linhas 98–113 (tabela `leads`): colunas `ia_score`, `ia_motivo_handoff`, etc. — **não há** `feedback_ia`, `feedback_ia_at` nem `feedback_ia_by`. Nenhuma migration 0003–0014 adiciona. | **Não existe.** Migration aditiva necessária. |
| 2 | O que o frontend envia hoje? | `Auditoria.jsx` → `avaliar(leadId,'bom'\|'ruim')` → `api.updateLead(token,id,{feedback_ia})` → `PATCH /leads/:id`. | Só `'bom'` / `'ruim'`. |
| 3 | O que as abas esperam? | `FILTROS = [pendentes, todas, bom, ruim, reuniao]`. `bom`/`ruim` filtram `l.feedback_ia`. **`reuniao` filtra `l.status_atual` (`reuniao_marcada`/`fechado`)** — nunca `feedback_ia`. | Enum de feedback = `{bom, ruim}`. `reuniao` é derivado, não é valor persistido. |
| 4 | Quem pode avaliar (UI)? | `App.jsx` linha 86: `podeVerIntegracoes = user.role === 'doctor' \|\| user.role === 'admin'`. A rota `/auditoria` está atrás desse gate. | Na UI, só `doctor`/`admin` legado chegam à tela. |
| 5 | Como o backend restringe o lead ao tenant? | `src/lib/authz.js` `authorizeResource` resolve a linha no servidor e escopa por `resolveScope` (tenant ON → `[req.tenant.doctorId]` da org selecionada; OFF → `getScopedDoctorIds`). Lead de outra org/doctor → `forbidden`; inexistente → `not_found`. O parâmetro `requireOwnerForCloser` (usado no `PATCH /leads/:id` geral) **não é usado** neste endpoint — ele abriria acesso ao closer por posse. | Reusar `authorizeResource` **sem** `requireOwnerForCloser`, com um gate de papel separado por cima. |
| 6 | closer / professional / owner / platform_admin devem avaliar? | Avaliar a IA é curadoria de qualidade = **ação exclusiva de gestão**. Papéis de gestão (migration 0012 / `mockSupabase`) = `organization_owner`, `organization_admin`, `manager`. `closer`/`viewer`/`financial`/`receptionist`/`professional` são papéis operacionais/restritos. Posse do lead não é papel. | **Autorizados:** legado `admin`/`doctor` (no próprio escopo); tenant `organization_owner`/`organization_admin`/`manager`; `platform_admin` (escopado à org). **Bloqueados em todos os modos:** `closer` (mesmo dono/responsável), `viewer`, `financial`, `receptionist`, `professional`, papel desconhecido, sem membership, membership suspensa. |
| 7 | Já existe coluna de data/autor da avaliação? | Não (ver #1). | Criar `feedback_ia_at` + `feedback_ia_by`. |
| 8 | `updateLead` geral é o contrato adequado? | O `updateSchema` de `/leads` é `.strict()` e cobre `status_atual, dados_extraidos, nome, telefone, email, journey_type, sdr_responsavel_id, atendido_por`. Adicionar `feedback_ia` ali misturaria a curadoria da IA com edição de dados de lead e com o gate de `sdr_responsavel_id`. | **Endpoint dedicado** é mais correto e mais restrito. |

### Ambiguidades levadas ao usuário (respondidas antes de implementar)
- **Enum:** decidido `'bom' \| 'ruim' \| null` — `reuniao` continua derivado de `status_atual`.
- **Limpeza:** reclicar o mesmo polegar limpa (envia `null`). Endpoint aceita `null`.
- **Papéis:** **exclusivo de gestão.** Gate de papel próprio (não o `requireOwnerForCloser`
  do endpoint geral) — bloquear `closer` (mesmo dono/responsável), `viewer`,
  `financial`, `receptionist`, `professional` e qualquer papel desconhecido.
  *(Correção material aplicada após a autorização inicial: `closer` dono foi
  removido dos autorizados; `authorizeResource` passou a ser chamado sem
  `requireOwnerForCloser`.)*

---

## 2. Contrato escolhido e justificativa

**Endpoint dedicado** `PATCH /leads/:id/ai-feedback`.

```
PATCH /leads/:id/ai-feedback
Authorization: Bearer <jwt>          # identidade — única fonte do autor
X-Organization-Id: <org>             # tenant — via tenantContext, nunca body
Body (schema .strict()):
  { "feedback": "bom" | "ruim" | null }

200 → { id, feedback_ia, feedback_ia_at, feedback_ia_by }   # resposta mínima
400 invalid_payload   | 401 (sem token) | 403 forbidden | 404 not_found
```

**Justificativa vs. `updateLead` geral:** (a) `feedback_ia` é curadoria da IA, não
edição de lead; (b) o endpoint dedicado tem gate de papel próprio (**exclusivo de
gestão**) que o `PATCH /leads/:id` não tem; (c) mantém o `updateSchema` geral
intocado; (d) autor e timestamp são server-side — impossível o cliente
falsificá-los porque o schema `.strict()` recusa `feedback_ia_by`/`feedback_ia_at`
no body.

**Não aceita:** `doctor_id`, `organization_id`, `unit_id`, `role`, `score`,
`etapa`, `feedback_ia_by`, `feedback_ia_at`, ou qualquer campo extra → `.strict()`
→ 400.

**Idempotência:** reavaliar com o mesmo valor devolve o estado já persistido sem
reescrever (o timestamp não se move).

**Duas camadas independentes, nesta ordem:**
1. **Autorização de papel** (`podeAvaliarFeedbackIa`) — gestão apenas. **Posse ou
   atribuição do lead NÃO concede acesso.** `authorizeResource` é chamado **sem**
   `requireOwnerForCloser` justamente para não abrir caminho ao closer por posse.
2. **Resolução e escopo do recurso** (`authorizeResource`) — o lead precisa existir
   e cair no escopo de tenant/doctor (tenant ON → `[req.tenant.doctorId]` da org
   selecionada; legado → `getScopedDoctorIds`). Fora do escopo → 403; inexistente
   → 404.

---

## 3. Papéis autorizados

> **Closer não pode avaliar feedback da IA, mesmo quando é responsável ou
> proprietário do lead.** Nenhuma regra de posse (`requireOwnerForCloser`,
> `sdr_responsavel_id`, `user_doctor_access`) autoriza a avaliação.

| Contexto | Autorizado | Bloqueado |
|---|---|---|
| `TENANT_CORE_ENABLED=false` (legado) | `users.role` ∈ {`admin`, `doctor`} — e o `doctor` só dentro do `doctor_id` do seu escopo (`getScopedDoctorIds`) | `closer` (mesmo dono/responsável), e qualquer outro papel |
| `TENANT_CORE_ENABLED=true` | membership `role` ∈ {`organization_owner`, `organization_admin`, `manager`}; `platform_admin` (sempre escopado à organização selecionada pelo `tenantContext`) | `closer` (mesmo com membership ativa e atribuído ao lead), `viewer`, `financial`, `receptionist`, `professional`, papel desconhecido, sem membership ativa, membership suspensa (estes três já barrados no `attachTenantContext`) |

O gate de papel roda **antes** de `authorizeResource`. O escopo de tenant/doctor
é sempre obrigatório: `doctor` legado só avalia leads do próprio `doctor_id`;
papéis de gestão tenant e `platform_admin` só avaliam leads da **organização
selecionada**.

---

## 4. Migration e rollback

`migrations/0015_ai_feedback.sql` (+ cópia idêntica `supabase/migrations/00000000000015_ai_feedback.sql`):

- `alter table public.leads add column if not exists feedback_ia text`
- `... feedback_ia_at timestamptz`
- `... feedback_ia_by uuid references public.users(id) on delete set null`
- `constraint leads_feedback_ia_check check (feedback_ia is null or feedback_ia in ('bom','ruim'))`
- **sem índice** (a Auditoria filtra em memória), **sem grant novo** (`feedback_ia*`
  fora do grant de UPDATE do `authenticated` — toda escrita passa pela API/service-role,
  igual ao AR-2 da migration 0008), **sem policy nova** (as policies row-level de `leads` já cobrem as colunas).

`migrations/0015_ai_feedback.rollback.sql`:
- `drop constraint if exists leads_feedback_ia_check` + `drop column if exists` das 3 colunas.
- **Não** toca nenhuma outra coluna/constraint/policy/grant.

SHA-256 original == cópia CLI: `086dd4ef9b3692dd16188c780817489a0a4bbae311ed474bfcfc9c7c1f9fe57f`.

---

## 5. Backend

`src/routes/leads.js` — novo handler `PATCH /:id/ai-feedback` (registrado antes de
`/:id`; padrões existentes: `requireAuth`, `attachTenantContext`, zod `.strict()`,
`next(e)` para o handler central que nunca vaza stack). Fluxo em **três etapas
separadas**:

1. `podeAvaliarFeedbackIa(req)` — **gate de papel, exclusivo de gestão**. Tenant ON:
   `req.tenant.isPlatformAdmin === true` OU `req.tenant.role ∈ {organization_owner,
   organization_admin, manager}`. Tenant OFF: `req.user.role ∈ {admin, doctor}`.
   Qualquer outra coisa (`closer` incluído, mesmo dono do lead) → **403**. Roda
   **antes** de tocar no recurso.
2. `authorizeResource({ req, table:'leads', id })` — **sem** `requireOwnerForCloser`.
   Confirma existência + escopo de tenant/doctor. Fora do escopo → 403; inexistente
   → 404.
3. `aiFeedbackSchema.safeParse` (`.strict()`) → 400 em qualquer campo extra.

Log estruturado `{ leadId, feedback }` — sem nome, telefone ou conteúdo de
conversa. Idempotência: `feedback` igual ao já persistido devolve o estado sem
reescrever. Resposta montada campo a campo (nunca a linha inteira, mesmo que o
driver ignore a projeção).

Constantes: `AI_FEEDBACK_TENANT_ROLES` = `{organization_owner, organization_admin,
manager}`; `AI_FEEDBACK_LEGACY_ROLES` = `{admin, doctor}`. **Não** há referência a
`closer`, `requireOwnerForCloser` (no handler) ou `canManage`.

---

## 6. Frontend

- `src/api/client.js` — novo método `updateLeadAiFeedback(token, leadId, feedback)`
  → `PATCH /leads/:id/ai-feedback` com body **exatamente** `{ feedback }`. Mock coerente.
- `src/pages/Auditoria.jsx` — `avaliar()` usa **só** esse método; reclicar o mesmo
  polegar envia `null` (toggle); a linha só muda depois da resposta da API
  (`res.feedback_ia`); guarda `if (salvandoId) return;`; erro → `<ErrorState>`.
  Layout e DS da FASE 3.3 preservados. Nenhuma outra tela alterada.

---

## 7. Impacto Meta / Auth

Nenhum. `Integrations.jsx`, Embedded Signup, WhatsApp, `AceitarConvite.jsx`,
`SetPassword.jsx`, `src/middleware/auth.js` — não tocados. Rotas e `HashRouter`
inalterados. `tenantSelection.js` / `App.jsx` inalterados.
