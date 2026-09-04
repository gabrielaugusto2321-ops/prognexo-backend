# FASE FUTURA — Cutover de equipe: `user_doctor_access` → `memberships`

Tarefa explícita exigida pela Decisão 3 do proprietário na FASE 2.3.
**Não fazer nesta fase.** Aqui só o plano.

## Situação atual (pós-FASE 2.3)

- **Fonte de verdade da equipe:** `public.user_doctor_access` (par `user_id`,`doctor_id`).
- `public.memberships` (FASE 2.1) existe e foi preenchida pelo `backfill_tenant_core()`
  (owner → `organization_owner`, cada `user_doctor_access` → `closer`).
- `/team` (POST/DELETE/PATCH) escreve **somente** em `user_doctor_access`. **Sem dual-write.**
- `GET /team` faz **shadow-read** (`src/lib/teamShadowRead.js`) quando
  `TENANT_CORE_ENABLED=true`: compara os dois lados e **registra** divergência via
  `logger.warn` (`onlyLegacy`, `onlyMembership`, `legacyButSuspendedMembership`).
  **Nunca corrige, nunca promove papel, nunca altera a fonte de verdade.**

## Por que o cutover é uma fase própria

- um dual-write **não-transacional** entre `user_doctor_access` e `memberships`
  pode deixar os dois lados divergentes em caso de falha parcial;
- `memberships` tem **papel** (`role`) e **status** (`active/suspended/invited`) —
  `user_doctor_access` não tem nenhum dos dois; a migração precisa decidir o papel
  de cada vínculo existente (hoje todos viram `closer` no backfill);
- `memberships` é por **organização**, `user_doctor_access` é por **doctor**; um
  usuário com acesso a N doctors da mesma futura organização precisa de **1**
  membership, não N;
- o frontend (`/equipe`, `Team.jsx`) consome o modelo "doctor = clínica" e o
  contrato de `/team`; mudar a fonte muda o contrato.

## Plano do cutover (fase própria, com gates)

1. **Convergência:** rodar o shadow-read em staging por um período; zerar toda
   divergência manualmente (ou com um script idempotente auditado).
2. **Dual-write transacional:** `/team` passa a escrever nos dois lados dentro de
   uma transação (ou via função `plpgsql` única). `memberships` ganha o papel
   informado explicitamente pelo médico (não mais `closer` fixo).
3. **Leitura de `memberships`:** `/team` e `getScopedDoctorIds` passam a ler de
   `memberships` quando `TENANT_CORE_ENABLED=true`, com `user_doctor_access` como
   fallback.
4. **Convite/suspensão:** implementar `status='invited'` e `status='suspended'`
   no fluxo de `/team` (hoje remover = `DELETE`).
5. **Cutover:** `memberships` vira fonte de verdade; `user_doctor_access` passa a
   ser espelho read-only mantido por trigger, depois deprecado.
6. **Remoção:** migration que remove `user_doctor_access` (só após período de
   observação e backup).

## Restrições herdadas

- não remover `doctor_id`;
- não ligar `TENANT_CORE_ENABLED` remoto sem gate;
- não promover papéis automaticamente;
- `organization_admin`/`organization_owner` nunca viram `platform_admin`
  (garantido pela policy `membership_org_admin_write` da 0008).
