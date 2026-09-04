# 23 — Auditoria: cutover do módulo de equipe para memberships (FASE 2.6)

Escopo: mapear TODO fluxo que hoje decide "quem gerencia quem" na equipe, antes de
qualquer implementação. Nenhuma linha de produção foi alterada para produzir este
documento (só leitura).

**Nota de terminologia**: toda menção a "Supabase" neste documento e nos testes desta
fase se refere exclusivamente à **instância local do Supabase CLI, executada em
containers Docker na máquina de desenvolvimento** (`127.0.0.1:54321`/`:54322`,
`config.toml` com `project_id = "prognexo-local"`, `linked_project: null`, sem
`supabase/.temp/project-ref`). Nunca "Supabase real" no sentido de projeto hospedado
— essa frase foi usada de forma ambígua numa saída anterior e está corrigida aqui.

## 1. Modelo de dados atual (fatos verificados no código/migrations)

- `users.role` — **CHECK constraint travado em `('admin','doctor','closer')`**
  (`supabase/migrations/00000000000000_baseline.sql:37`). Os 8 papéis novos
  (`organization_owner`, `organization_admin`, `manager`, `closer`, `receptionist`,
  `professional`, `financial`, `viewer`) **não cabem** nessa coluna — e não devem: eles
  vivem exclusivamente em `memberships.role`, que já tem exatamente esses 8 valores
  no CHECK (`migrations/0008_tenant_core.sql:37-39`), **mais `platform_admin`** (9 no total
  na tabela, mas `platform_admin` só é atribuído via `platform_admins`, nunca via
  `memberships.role='platform_admin'` na prática — a policy de escrita bloqueia isso
  para todo mundo exceto quem já É platform_admin, ver §3).
- `memberships` (0008): `(id, organization_id, user_id, role, status, ...)`,
  `unique(organization_id, user_id)`, `status in ('active','suspended','invited')`.
- `membership_units` (0008): `(membership_id, unit_id)` — sem organization_id própria;
  a organização vem transitivamente pela membership.
- `organization_doctor_map` (0008): `unique(doctor_id)` → **1 doctor = no máximo 1 org**,
  e a organização inteira mapeia para **um único** `doctor_id` "legado". Isso simplifica
  a ponte: dado `organization_id`, existe no máximo um `doctor_id` correspondente.
- `platform_admins` (0008): tabela própria, `user_id` PK. `is_platform_admin()` =
  `platform_admins` OU `users.role='admin'` (o admin legado global já conta).
- `user_doctor_access` (legado, pré-existente): `(user_id, doctor_id)` — só modela
  "closer vinculado a um médico". **Não tem status** (sempre implicitamente ativo) e
  **não tem conceito de papel** (todo vínculo aqui é sempre `closer`).
- `doctors.owner_user_id` — o dono da clínica; vira `organization_owner` no backfill.

## 2. `/team` hoje — 100% legado, NÃO passa por tenant/membership

Arquivo: `src/routes/team.js`. **Não importa `attachTenantContext`, `tenantContext.js`
nem `req.tenant`** — usa só `req.user.role` (via `requireAuth`) e
`getScopedDoctorIds(req.user)` (`src/middleware/auth.js`).

| Rota | Autorização hoje | Fonte de dados | Classificação |
|---|---|---|---|
| `GET /team?doctor_id=` | `requireDoctorOrAdmin` (`user.role in admin,doctor`) + `scopedIds.includes(doctor_id)` | `user_doctor_access` + `doctors.distribuicao_automatica` + `leads` (contagem) | **escrita/leitura legada** |
| `PATCH /team/distribuicao` | idem | `doctors.distribuicao_automatica` | **leitura/escrita legada** (fora do escopo de membership — fica como está) |
| `POST /team` (convidar) | idem | `supabase.auth.admin.inviteUserByEmail` (envia e-mail real!) + INSERT `users` (role fixo `'closer'`) + INSERT `user_doctor_access` | **bloqueador do cutover** — cria só `closer`, nunca outro papel; sem RPC; 3 escritas não-transacionais (auth → users → user_doctor_access); nenhuma auditoria |
| `DELETE /team/:userId?doctor_id=` | idem | DELETE `user_doctor_access` | **escrita legada** (remove só o vínculo, não a conta — correto, mas sem conceito de "papel"/"suspender") |

`shadowCompareTeam` (`src/lib/teamShadowRead.js`) já roda em todo `GET /team` quando
`TENANT_CORE_ENABLED=true`, comparando `user_doctor_access ∪ {owner_user_id}` com
`memberships` ativas — **classificação: já baseada em membership, mas só leitura
comparativa (shadow), zero efeito no banco ou na resposta**. Mantido nesta fase.

**Não existe hoje**: alterar papel, suspender, reativar, atribuir/remover unidade. Essas
operações são 100% novas — não há "legado" para preservar nelas, só para os 4 endpoints
acima.

## 3. RLS/RPC de `memberships` já existente (FASE 2.1, `0008_tenant_core.sql`) — reaproveitar, não recriar

Já implementado e **já testado** em `test/rls/tenant-core.rls.test.js`:

- `is_org_member(org)`, `has_org_role(org, roles[])`, `is_platform_admin()` — `SECURITY
  DEFINER`, `search_path=''`, sem `EXECUTE` para `anon`. **Já baseado em membership.**
- Policy `membership_org_admin_write` (WITH CHECK): platform_admin sempre pode;
  `organization_owner` pode setar qualquer `role` **exceto** `'platform_admin'`;
  `organization_admin` só pode setar `role in (manager,closer,receptionist,professional,
  financial,viewer)` — **nunca** `organization_owner`/`organization_admin`/`platform_admin`.
  Isso já cobre, na íntegra, as regras da ETAPA 3: "admin não cria owner", "admin não cria
  platform_admin", "admin gerencia só papéis inferiores".
- Testado: owner concede papel comum (permitido); owner NÃO cria `platform_admin`
  (bloqueado); closer NÃO escreve em `memberships` (bloqueado); closer NÃO se
  auto-promove via UPDATE direto (bloqueado/0 linhas); `is_platform_admin` correto.

**O que falta e é o núcleo real desta fase**:
1. **Proteção do último owner** — não existe em lugar nenhum (nem RLS, nem app). Uma
   policy RLS não enumera facilmente "sou o único owner ativo desta org" de forma segura
   contra corrida; isso é trabalho de **RPC transacional** (`SELECT ... FOR UPDATE` /
   contagem dentro da mesma transação do UPDATE).
2. **RPCs de operação** (invite/change-role/suspend/reactivate/remove/unit) — não
   existem. Hoje qualquer escrita em `memberships` seria feita direto pelo
   PostgREST (`.update()`/`.insert()`), o que é suficiente para RLS simples mas
   **não** para: (a) checar último-owner atomicamente, (b) manter a ponte
   `user_doctor_access` em sincronia na mesma transação, (c) gravar auditoria
   garantida.
3. **admin auto-promoção**: a policy hoje bloqueia `organization_admin` de setar papel
   `organization_admin`/`owner`/`platform_admin` para QUALQUER linha — inclusive a
   própria. Isso já impede auto-promoção a um papel superior. Falta explicitamente
   impedir um `organization_admin` de **alterar a própria linha para qualquer coisa**
   (ex.: rebaixar-se para escapar de auditoria, ou "reativar-se" depois de suspenso por
   um owner) — regra de produto, não só de escalonamento; tratado na RPC.
4. **`manager`**: não tem nenhuma policy hoje que autorize escrita em `memberships` —
   `has_org_role(org, [owner,admin])` é a única condição de escrita. Ou seja, **manager
   já está bloqueado de tocar `memberships` diretamente pela RLS atual**. A ETAPA 3 pede
   que ele tenha "só as permissões explicitamente necessárias" — nesta fase, **zero**
   (não gerencia equipe), o que já é o comportamento hoje. Nenhuma mudança de RLS
   necessária para `manager`.

## 4. Ponte legada (`user_doctor_access`) — o que ela pode e não pode representar

Como `organization_doctor_map` é `unique(doctor_id)`, cada organização corresponde a
**no máximo um** `doctor_id` legado. Logo:

- **`role='closer'`** numa organização com `doctor_id` mapeado → tem equivalente exato
  em `user_doctor_access(user_id, doctor_id)`. A RPC de convite/remoção/suspensão de um
  `closer` PODE (e deve) manter essa linha em sincronia, na mesma transação.
- **`role='organization_owner'`** → não usa `user_doctor_access` (o owner já enxerga tudo
  via `doctors.owner_user_id`, path separado em `getScopedDoctorIds`). Nada a sincronizar.
- **`organization_admin`, `manager`, `receptionist`, `professional`, `financial`,
  `viewer`** → **não têm nenhum equivalente no modelo legado**. `user_doctor_access` não
  tem conceito de papel — é binário "vê os leads do doctor ou não". Criar uma membership
  com um desses papéis **não pode e não deve** gerar uma linha em `user_doctor_access`:
  não existe uma tradução correta (um `financial` não deveria ganhar acesso de `closer`
  aos leads). **Decisão de design**: só `closer` é ponte'd; os demais papéis novos são
  **funcionalidade nova, disponível apenas com `TEAM_MEMBERSHIPS_ENABLED=true`** — com
  `false`, esses usuários simplesmente não aparecem/não têm efeito nas rotas legadas
  (comportamento seguro por padrão: sem flag, sem acesso extra nenhum).
- **Suspender/reativar/remover um `closer`** → precisa remover/reinserir a linha em
  `user_doctor_access` atomicamente com a mudança de `status`/remoção da membership.
- Divergências (membership sem ponte, ponte sem membership) já são hoje só
  **logadas** por `teamShadowRead` — nunca corrigidas automaticamente. Mantido.

## 5. Frontend — inventário

| Arquivo | Uso de papel/tenant | Classificação |
|---|---|---|
| `src/App.jsx` | `podeGerenciarEquipe = user.role==='doctor'\|\|user.role==='admin'` (role **legado**, de `users`, nunca de `memberships`) | **leitura legada** — só sabe admin/doctor/closer |
| `src/components/Sidebar.jsx` | recebe `showTeamLink` já calculado; não decide nada | fora do escopo (consumidor puro) |
| `src/pages/Team.jsx` | `doctorId = admin ? getSelectedDoctor() : currentUser.doctor_id`; só lista+convida+remove closer; sem papel/suspensão/unidade | **bloqueador do cutover** (precisa de UI nova) |
| `src/api/client.js` | `getTeam/inviteCloser/removeCloser/toggleDistribuicaoAutomatica` — todos mandam `doctor_id` explícito do cliente (não `organization_id`/role) | **ponte de compatibilidade** aceitável — `doctor_id` aqui não é autoridade, o backend sempre revalida com `scopedIds`/`tenant`; precisará de métodos novos para as operações novas |
| `GET /tenant/context` (já existe, FASE 2.3) | **já devolve `organizations[].role`** resolvido pelo servidor por organização | **já baseado em membership** — é o hook pronto para o frontend saber o papel do usuário na org selecionada, sem inventar nada novo |

**Achado importante**: o frontend **já tem acesso ao papel de membership** via
`ctx.organizations[].role` (retornado por `/tenant/context`), mas `App.jsx` hoje descarta
essa informação (só guarda `id`/`name`/`units`). Não precisa de endpoint novo para o
gate do frontend — só passar `role` adiante.

## 6. Outras rotas/telas que dependem de `users.role` (não tocadas nesta fase)

`Dashboard`, `Leads`, `Pipeline`, `Agenda`, `Conversas`, `Relatorios`, `Reativacao`,
`Agentes`, `BaseConhecimento`, `Campanhas`, `Integrations`, `Doctors`, `Onboarding` — todas
usam `currentUser.role` (legado) e/ou `resolveDoctorId`/`getScopedDoctorIds` para escopo
de dados, **não** para gestão de equipe. **Fora do escopo desta fase** — nenhuma dessas
rotas grava/lê `memberships` para decidir autorização de dados; o cutover de FASE 2.6
é só sobre **quem pode administrar quem na equipe**, não sobre re-escopar leads/agenda/etc.
(isso já foi feito, parcialmente, na FASE 2.3 via `attachTenantContext`).

## 7. Signup / Activation / Onboarding

`POST /signup`, `POST /activation/complete`, `Onboarding.jsx` — criam o **primeiro**
usuário de uma clínica (futuro `doctor`/`organization_owner`). Não usam
`user_doctor_access` nem `memberships` diretamente hoje (o backfill/trigger de
`organization_doctor_map` é quem gera a membership de owner, no fluxo atual só para
doctors pré-existentes via `backfill_tenant_core()`). **Fora do escopo** desta fase —
nenhuma mudança necessária; **risco identificado, não corrigido**: um doctor criado
via signup DEPOIS do backfill inicial só ganha `organization_doctor_map`/membership de
owner na próxima execução do backfill (idempotente) — hoje isso já é assim para
qualquer feature de tenant-core; não é introduzido por esta fase.

## 8. Uso de service-role / escrita direta do browser

Toda escrita de equipe hoje passa pelo backend (service-role) — o browser nunca grava em
`user_doctor_access` nem em `memberships` diretamente (RLS de `memberships` permite
escrita a `owner/admin/platform_admin` via `authenticated`, mas o frontend atual não
expõe UI para isso; é superfície JÁ aberta pela 0008, não nova). O `POST /team` chama
`supabase.auth.admin.inviteUserByEmail` — **API admin do Supabase Auth, exige
service-role**, já assim hoje; mantido; **nenhum e-mail deve ser disparado em teste**
(mockar `supabase.auth.admin.inviteUserByEmail` nos testes, nunca chamar de verdade).

## 9. Meta / Embedded Signup / WhatsApp

Nenhuma menção a Meta, `embeddedSignup`, `window.FB`, `waba`, `phone_number_id` em
`team.js`, `teamShadowRead.js`, `Team.jsx` ou em qualquer arquivo listado acima.
**Zero relação.** Confirmado por leitura direta de todos os arquivos do módulo.

## 10. Tabela de classificação (resumo)

| Item | Classificação |
|---|---|
| `is_org_member`/`has_org_role`/`is_platform_admin` (0008) | já baseada em membership |
| Policy `membership_org_admin_write` (anti-escalonamento) | já baseada em membership |
| `shadowCompareTeam` | ponte de compatibilidade (comparação, sem escrita) |
| `GET/POST/DELETE /team`, `PATCH /team/distribuicao` | leitura/escrita legada |
| `POST /team` → `auth.admin.inviteUserByEmail` + 2 inserts não-transacionais | **bloqueador do cutover** |
| Ausência de RPC para invite/role/suspend/reactivate/remove/unit | **bloqueador do cutover** |
| Ausência de proteção de último owner | **bloqueador do cutover** |
| `user_doctor_access` como ponte só para `closer` | ponte de compatibilidade (decisão de design, §4) |
| `manager` sem policy de escrita em `memberships` | já correto (nenhuma mudança) |
| `Team.jsx` (sem papel/suspensão/unidade) | bloqueador do cutover (frontend) |
| `App.jsx` descarta `organizations[].role` | leitura legada — 1 linha para corrigir |
| Dashboard/Leads/Pipeline/etc. | fora do escopo |
| Signup/Activation/Onboarding | fora do escopo (risco pré-existente, não novo) |
| `platform_admin` (fonte: `platform_admins` + `users.role='admin'`) | global da plataforma — não tocar nesta fase |
| Meta/Embedded Signup/WhatsApp | fora do escopo — zero relação confirmada |
| Rate limit de `/team` (inexistente) | risco de escalonamento operacional (spam de convites) — mitigar com limiter dedicado nas novas RPC routes |

## 11. Conclusão da auditoria

O cutover é viável de forma **aditiva e segura**: a base RLS anti-escalonamento de
`memberships` (FASE 2.1) já existe e já está testada; o trabalho real desta fase é
(1) RPCs transacionais com proteção de último-owner e sincronia com a ponte `closer`,
(2) reescrever os 4 endpoints de `/team` para, sob a flag, ler de `memberships` e
escrever via RPC, preservando 100% o contrato de resposta atual quando a flag está
desligada, e (3) uma UI nova (papel/suspender/reativar/unidade) que hoje simplesmente
não existe. Nenhum ponto de bloqueio relacionado a Meta, credenciais ou acesso remoto
foi encontrado — pode prosseguir para as próximas etapas.

## 12. Implementado — modelo de papéis, RPCs e achados corrigidos

### Papéis (centralizados, nunca inventados no cliente)

`memberships.role` (0008): `organization_owner`, `organization_admin`, `manager`,
`closer`, `receptionist`, `professional`, `financial`, `viewer` — mais `platform_admin`,
que só vem de `platform_admins`/`users.role='admin'`, nunca de uma linha de
`memberships`. Matriz de concessão (`team_role_grantable`, espelha a policy
`membership_org_admin_write` de 0008):

| ator | pode conceder |
|---|---|
| `platform_admin` | qualquer papel |
| `organization_owner` | qualquer papel exceto `platform_admin` |
| `organization_admin` | `manager, closer, receptionist, professional, financial, viewer` (nunca owner/admin/platform_admin) |
| `manager` e abaixo | nenhum (não gerenciam equipe nesta fase) |

Confirmado por revisão independente (Codex): nenhum caminho de `organization_admin`
para `organization_owner`, incluindo ao alterar a própria membership.

### RPCs (migration 0012)

`team_member_add`, `team_member_change_role`, `team_member_set_status`,
`team_member_remove`, `team_member_set_units`, `team_backfill_reconcile` — todas
`SECURITY DEFINER`, `search_path=''`, `EXECUTE` revogado de `PUBLIC` e de
`anon`/`authenticated` explicitamente (só `service_role`). Ator sempre por parâmetro
(`p_actor_user_id`), resolvido no backend do Bearer token — nunca do body.

**Defesa em duas camadas** (achado do processo: em ambiente CLI local, `revoke
execute ... from anon, authenticated` sozinho não bastou — havia também um grant a
`PUBLIC` que precisou ser revogado explicitamente; ver commit da migration):
1. grants revogados (anon/authenticated/PUBLIC sem `EXECUTE`, só `service_role`);
2. cross-check `auth.uid()`: se existe uma sessão de usuário de verdade
   (`auth.uid() is not null` — nunca acontece na conexão service_role do backend),
   a função exige `auth.uid() = p_actor_user_id`, fechando impersonation mesmo que a
   camada 1 falhe por algum motivo do ambiente. Provado com Postgres real chamando
   as RPCs como `authenticated` com JWT de um usuário tentando alegar ser outro.

### Achado CRÍTICO/ALTO corrigido: corrida no último owner

Revisão adversarial (própria + confirmada independentemente pelo Codex) encontrou:
sob `READ COMMITTED`, duas transações rebaixando/suspendendo/removendo **dois owners
diferentes** ao mesmo tempo podiam ambas contar "2 owners ativos" (nenhuma das duas
tinha commitado ainda) e ambas prosseguirem — zerando os owners da organização.
O `FOR UPDATE` na linha-alvo não serializa contra mudanças em **outras** linhas de
owner.

**Correção**: a contagem de owners agora trava (`FOR UPDATE`, em ordem determinística
por `id`) **todas** as linhas `organization_owner` ativas da organização antes de
contar — não só a linha-alvo. Isso serializa as duas transações: a segunda espera a
primeira commitar e recontar contra o estado já atualizado. Aplicado às três RPCs
(`change_role`, `set_status`, `remove`).

**Efeito colateral aceito**: com dois targets diferentes disputando o mesmo conjunto
de locks, o Postgres pode preferir abortar uma das transações com `deadlock detected`
(SQLSTATE `40P01`) em vez de deixar minha exceção `last_owner_protected` rodar — a
garantia de "nunca zero owners" continua 100% válida (o Postgres garante que uma das
duas transações não aplica nada), só muda qual mensagem de erro o perdedor recebe.
`rpcErrorResponse` (`src/routes/team.js`) trata isso como `409 concurrent_update`
("tente de novo"), nunca como `500`. Provado com um teste real de corrida em
Postgres (dois `pg.Pool` disputando os dois owners ao mesmo tempo): exatamente uma
vence, a organização nunca fica com zero owners.

### Achado MÉDIO — conta órfã se a RPC negar o convite (mitigado, NÃO eliminado)

`POST /team` cria o usuário no Supabase Auth + `users` **antes** de chamar a RPC (a
chamada de Auth é externa, não pode fazer parte da transação SQL). Se a RPC recusar
(papel não concedível, unidade inválida, conflito), a conta ficava criada sem
membership. **Mitigação aplicada**: em caso de erro da RPC, o handler tenta remover a
linha de `users` e a conta de Auth (melhor esforço).

**Isto NÃO é atomicidade total e o risco residual está registrado, não escondido:**
se (a) a criação no Auth funcionar, (b) a RPC falhar, e (c) a remoção compensatória
no Auth **também** falhar (rede, rate limit do Supabase Auth, etc.) — uma conta Auth
pode ficar de fato órfã, sem membership nenhuma. Garantias que **seguram** esse
cenário (verificadas, não apenas presumidas):

| garantia exigida | status | prova |
|---|---|---|
| conta órfã nunca recebe acesso a organização | ✅ garantido | sem `memberships`, `attachTenantContext` retorna `403 no_active_membership` antes de qualquer rota tenant-scoped rodar — não depende da RPC ter limpado nada |
| login sem membership retorna 403 (não 200 "vazio") | ✅ garantido | mesmo mecanismo acima; testado (`test/team-api.test.js`, "CONTA ÓRFÃ — usuário sem NENHUMA membership") |
| falha do cleanup gera log redigido | ✅ garantido | `req.log?.error(...)` nas duas tentativas de limpeza (`users` e Auth), nunca solto sem log; nunca contém token/segredo (só o erro e o id) |
| falha do cleanup gera **alerta operacional** | ⚠️ parcial | este projeto não tem um sistema de alerta dedicado (pager/Slack/etc.) — o log de erro estruturado (pino) é o único mecanismo hoje, igual a todo o resto do backend. Não é uma lacuna introduzida por esta fase; registrado aqui para não parecer mais forte do que é |
| nenhum e-mail real é enviado **antes** de a membership ser confirmada | ❌ **não garantido nesta fase** | `supabase.auth.admin.inviteUserByEmail` roda **antes** da RPC — é ele quem cria a conta E dispara o e-mail no mesmo passo; não há como adiar o e-mail sem redesenhar o fluxo (precisaria de um convite "nosso", com token próprio, e só chamar o Supabase Auth depois que a pessoa aceitar) |
| teste de falha da própria compensação | ✅ criado | `test/team-api.test.js`, "CONTA ÓRFÃ — mesmo se a limpeza compensatória também falhar" — simula falha em `auth.admin.deleteUser` **e** em `users.delete()`; confirma resposta 403 (não 500, não trava) |
| prova de que a conta órfã não acessa nenhum tenant | ✅ criado | mesmo teste acima da linha "login sem membership" |

**Pior caso honesto**: se as duas limpezas falharem, a pessoa convidada recebeu um
e-mail de convite real e pode até definir uma senha — mas a conta **não enxerga
nenhuma organização, nenhum lead, nenhuma tela tenant-scoped** (barrada pela
mesma proteção que qualquer usuário sem membership enfrenta). O dano é uma UX
confusa (convite que não leva a lugar nenhum), não um buraco de segurança.

**Tarefa futura registrada (não implementada nesta fase, por decisão explícita do
usuário — "não precisa redesenhar")**: fluxo de convite persistente/outbox — criar
primeiro um registro interno de convite (token próprio, sem tocar o Supabase Auth),
só chamar `inviteUserByEmail` depois que a RPC de `team_member_add` já tiver
succedido (ou nunca, se a pessoa aceitar via link próprio e só então criar a conta
Auth) — eliminaria o problema pela raiz, mas é uma mudança de arquitetura do fluxo de
convite, fora do escopo desta fase.

### Correção do BLOQUEADOR — hierarquia estrita admin-vs-admin (era "aceito", agora corrigido)

**Revisão anterior errou ao aceitar** que `organization_admin` pudesse
administrar outro `organization_admin` — isso contraria a regra aprovada
("organization_admin gerencia somente papéis inferiores ao próprio"). Corrigido em
todas as camadas:

1. **Migration 0012** — nova função `team_actor_can_manage_target(actor_role,
   target_role, is_self)`, consultada no banco (nunca no frontend/JWT) dentro de
   `team_member_change_role`, `team_member_set_status`, `team_member_remove`,
   `team_member_set_units`: `organization_admin` só administra alvo cujo papel
   **atual** esteja em `{manager, closer, receptionist, professional, financial,
   viewer}`, nunca a si mesmo; `organization_owner`/`platform_admin` são os únicos
   que administram uma membership `organization_admin` ou `organization_owner`.
2. **API `/team`** — nenhuma lógica própria de autorização; sempre delega à RPC e
   traduz `forbidden`→403 sem revelar detalhe do alvo (já era assim; validado com
   testes HTTP novos).
3. **Matriz de papéis** — `team_actor_can_manage_target` é a matriz centralizada
   (complementa `team_role_grantable`, que decide o papel NOVO; a nova função decide
   se o alvo pode sequer ser tocado).
4. **Frontend** (`Team.jsx`) — `podeAdministrarLinha(membro)` esconde o seletor de
   papel e os botões Suspender/Remover quando `membershipRole==='organization_admin'`
   e o alvo é outro admin, o próprio ator, ou um owner — só UI, o backend continua
   sendo a autoridade.
5. **Testes** — 18 cenários novos em Postgres real (`test/rls/team-memberships.rls.test.js`)
   + 9 no contrato HTTP mock (`test/team-api.test.js`), cobrindo cada uma das
   proibições, os dois casos permitidos (owner→admin, platform_admin→qualquer um),
   cross-tenant, chamada direta à RPC, atomicidade da negação e concorrência
   admin-vs-admin.
