# FASE 2.7 — Convites seguros, persistentes e com outbox

> Nota de terminologia (herdada da auditoria 23): toda menção a "Supabase"
> neste documento significa exclusivamente a instância **local em Docker**
> (`127.0.0.1:54321`/`54322`, `project_id="prognexo-local"`). Nunca um projeto
> hospedado. Nenhum comando desta fase usou `supabase link`, `db push` ou
> qualquer credencial de produção.

## 0. Por que esta fase existe

A auditoria 23 (FASE 2.6, `docs/platform/23-team-memberships-cutover-audit.md`)
já documentou, sem eufemismo, que o fluxo atual de convite em `POST /team` não
é atômico entre Supabase Auth e o Postgres: se a criação do usuário Auth tiver
sucesso e a RPC de membership falhar, a limpeza compensatória é *best-effort*
e pode falhar também, deixando uma conta Auth órfã. Essa conta nunca acessa
nenhum tenant (garantia já testada), mas o fluxo **não está autorizado para
produção** enquanto isso persistir. Esta fase resolve isso com um modelo
persistente de outbox — sem redesenhar o resto do módulo de equipe.

## 1. Auditoria do fluxo atual

### 1.1 `POST /team` (`src/routes/team.js:217-256`, modo `membershipsOn`)

Sequência atual, em passos HTTP/SDK separados (nenhuma transação cobre tudo):

1. `supabase.auth.admin.inviteUserByEmail(email)` — cria o usuário no Auth
   **e dispara o e-mail de convite do Supabase imediatamente**, antes de
   qualquer validação de negócio (papel concedível, unidade válida, conflito
   de membership já existente).
2. `insert into users(...)` com `role='closer'` (valor menos privilegiado do
   enum legado — não concede nada por si só).
3. RPC `team_member_add(...)` — só AQUI a hierarquia (FASE 2.6,
   `team_actor_can_manage_target`/`team_role_grantable`), o conflito de
   membership duplicada e a validação de unidade são checados.
4. Se a RPC falhar (`forbidden`/`conflict`/`invalid_role`/`unit_not_in_organization`),
   o handler tenta desfazer: `delete from users` e `auth.admin.deleteUser` —
   **sem transação, best-effort, cada um pode falhar independentemente**.

Achado confirmado (não novo, mas resumido aqui): o e-mail já foi enviado no
passo 1, antes de qualquer validação. Um `forbidden` no passo 3 significa que
a pessoa convidada recebeu um convite real e funcional para uma conta que o
servidor decidiu, um instante depois, que não deveria ter sido criada.

### 1.2 `memberships.status` — achado estrutural favorável

A tabela `memberships` (migration `0008_tenant_core.sql:40`) já declara:
```sql
status text not null default 'active' check (status in ('active','suspended','invited'))
```
O valor `'invited'` existe desde a FASE 2.1 e **nunca foi usado** —
`team_member_add` sempre insere com `status='active'` (linha 248 da migration
0012). Ou seja: hoje, uma membership existe como **ativa** desde o instante em
que a RPC roda, mesmo que a pessoa nunca tenha clicado no link nem definido
senha (ela simplesmente não consegue logar até isso acontecer — mas se algum
dia ela conseguisse autenticar por outro meio, a membership já estaria ativa).
A FASE 2.7 aproveita esse valor já existente no enum em vez de alterar o
schema: a membership nasce `status='invited'` e só vira `active` na aceitação.
**Nenhuma migration de dados é necessária** para isso — é um valor que o
`check` já permite.

### 1.3 `signup.js` (fluxo PÚBLICO de auto-cadastro — fora do escopo desta fase)

`POST /signup` também usa `inviteUserByEmail` (linha 45), com o mesmo padrão de
compensação best-effort (`deleteUser` em caso de falha). É um fluxo
**diferente e paralelo** (cadastro público de médico, não convite de equipe).
Esta fase **não o modifica** — mas o registra aqui porque compartilha a mesma
classe de risco. Uma tarefa futura (fora do escopo, registrada no `pending`
abaixo) deveria avaliar se o outbox desta fase se generaliza para lá também.

### 1.4 `activation.js` (`POST /activation/complete`) — padrão a reaproveitar

Este endpoint já resolve, para o fluxo de auto-cadastro, exatamente o
problema de "não confiar em nada que venha do corpo da requisição": a
identidade vem **só** do JWT (`Authorization: Bearer`), o corpo é ignorado, e
a ativação é idempotente e guardada contra corrida
(`update ... where status='pending'`). A FASE 2.7 replica este padrão para
`POST /team/invitations/:id/accept` (ver §7).

### 1.5 Resend (`src/lib/resend.js`)

`enviarEmail()` é uma chamada `fetch` direta à API do Resend, sem adapter
injetável, usada hoje só por `planos.js` (e-mail de boas-vindas pós-pagamento).
Não tem mock e não deve ser reutilizada como está: o worker desta fase precisa
de um **adapter de e-mail injetável**, com uma implementação fake usada em
dev/teste e a implementação Resend real desligada por padrão
(`TEAM_INVITE_EMAIL_DELIVERY_ENABLED=false`).

### 1.6 Rate limit, enumeração, auditoria

- `teamMutationLimiter` (`src/middleware/rateLimits.js:75`) já cobre `POST /team`
  por usuário autenticado (20/min) — será estendido às rotas novas de convite.
- `POST /team` **não é anti-enumeração** hoje (é uma rota autenticada,
  hierárquica, não pública) — `conflict` é retornado abertamente quando o
  e-mail já é membro. Isso é aceitável (o ator já enxerga a lista da equipe);
  o novo endpoint mantém esse padrão, mas nunca revela dados de **outro
  tenant** (cross-tenant sempre `404`, nunca `403` com detalhe).
- `team_membership_events` (auditoria da FASE 2.6) nunca grava PII — só ids,
  papel e status. O outbox desta fase segue a mesma regra: nunca token, nunca
  link, nunca e-mail em claro nos campos de auditoria/log.

### 1.7 Relação com a Meta/WhatsApp/Embedded Signup

**Inexistente.** Nenhum arquivo de `webhooks/whatsapp.js`, Embedded Signup ou
qualquer rota `/meta*`/`/whatsapp*` é tocado, lido ou referenciado por esta
fase. Convite de equipe e integração de canal são domínios completamente
desacoplados no schema atual.

## 2. Capacidades reais do SDK instalado (confirmado empiricamente)

SDK: `@supabase/supabase-js@^2.45.0` → resolve `@supabase/auth-js@2.112.2`
(`node_modules/@supabase/auth-js/package.json`). Testado ao vivo contra o
Supabase **local** (`127.0.0.1:54321`), com e-mails sintéticos
(`probe-*@x.test`), via um script descartável (`scripts/_probe-auth-admin*.mjs`,
apagado ao final — nunca commitado). Achados:

| Chamada | Cria usuário? | Envia e-mail automaticamente? | Retorna `action_link`? | Efeito de repetição |
|---|---|---|---|---|
| `auth.admin.inviteUserByEmail(email)` | sim | **sim, imediatamente** | não (só varia com `redirectTo`) | reenvia e-mail de novo a cada chamada |
| `auth.admin.createUser({ email, email_confirm:false })` | sim | **não** (`confirmation_sent_at` fica `undefined`) | não | 2ª chamada com mesmo e-mail → erro `422 email_exists` |
| `auth.admin.generateLink({ type:'invite', email })` | sim (se não existir) | **não** — é a própria doc do SDK que diz "generates links... to be sent via a custom email provider" | **sim** (`action_link`, `hashed_token`, `email_otp`) | ver abaixo |

Comportamento de **repetição** de `generateLink({type:'invite'})` — testado
diretamente, não assumido:

- 1ª chamada para um e-mail novo: cria o usuário (não confirmado), devolve um
  `hashed_token`/`action_link` novos.
- 2ª chamada para o **mesmo e-mail, ainda não confirmado**: **sucesso**,
  reaproveita o `user.id`, mas gera um `hashed_token`/`action_link`
  **diferentes** — e o token anterior passa a falhar
  (`Email link is invalid or has expired`) assim que o novo é emitido. Ou
  seja: **gerar um novo link invalida o anterior automaticamente** — a
  Supabase local já faz isso sozinha, sem eu precisar implementar invalidação
  manual do lado do token do GoTrue (a FASE 2.7 ainda mantém seu próprio
  `expires_at`/estado como fonte de verdade de negócio, mas o token do GoTrue
  já não é reutilizável por conta própria).
- Chamar `generateLink({type:'invite'})` sobre um usuário **já confirmado**
  (aceitou o convite antes, ou já tinha conta) → **erro 422 "already
  registered"**. `type:'invite'` só funciona para usuários nunca confirmados.
  Para reconvites a um e-mail que já é uma conta confirmada em outra
  organização, o mecanismo correto é `generateLink({type:'magiclink', email})`
  (testado, funciona) — **não** cria usuário novo nem exige senha nova, só
  autentica quem já existe. Esse é um ramo separado do fluxo principal (ver §4.6).
- `verifyOtp({ token_hash, type:'invite' })` (chamado do **frontend**, com a
  chave `anon`, no clique do link) consome o token: confirma o e-mail
  (`email_confirmed_at` passa a existir) e devolve uma sessão. **Uso único
  confirmado**: reusar o mesmo `hashed_token` uma segunda vez falha com
  `Email link is invalid or has expired` (403).

**Conclusão da ETAPA 3**: o SDK **permite** separar criação, geração do link
e envio com segurança. `generateLink({type:'invite', email})` é o único
primitivo que faz as três coisas que a fase pede sem enviar nada: cria (ou
reaproveita) o usuário Auth, devolve um link de uso único, e não dispara
e-mail — a entrega fica inteiramente sob nosso controle (outbox). Não é
necessário combinar `createUser` + `generateLink` em duas chamadas — uma só
chamada de `generateLink` já cobre a criação. `inviteUserByEmail` **não** é
usado no novo fluxo porque ele funde criação e envio numa única chamada
atômica do lado do GoTrue — exatamente o acoplamento que esta fase precisa
quebrar. O fluxo legado (flag desligada) continua usando
`inviteUserByEmail` inalterado.

## 3. Desenho do fluxo novo

```
1. POST /team/invitations (ator autenticado, hierarquia FASE 2.6)
   └─ RPC team_invitation_create (transação única):
        valida hierarquia + último-owner (n/a aqui) + unidade + duplicidade
        insert organization_invitations (status='pending', idempotency_key)
        return convite (sem token/link)

2. Job de provisionamento (chamado de dentro do mesmo request, síncrono —
   não precisa de outro worker: só a ENTREGA de e-mail é assíncrona):
   a) organization_invitations.status='pending' -> 'provisioning'
   b) auth.admin.generateLink({type:'invite', email}) — cria/reaproveita o
      Auth user, SEM enviar nada
   c) RPC team_invitation_attach_auth_user: grava auth_user_id, cria a
      membership com status='invited' (nunca 'active'), cria o profile em
      `users` (role='closer', legado), status da invitation -> 'ready'
      — tudo em UMA transação Postgres.
   d) se (b) falhar -> invitation vai a 'failed' com last_error_code redigido,
      NADA foi criado no Postgres, nenhum e-mail sai. Retomável (reprocessa
      o mesmo id).
   e) se (c) falhar -> compensação best-effort do Auth user (igual à FASE
      2.6, documentada como best-effort), invitation -> 'failed'. Estado
      RETOMÁVEL (não deixa outbox pendente sem link correspondente).
   f) se (c) tiver sucesso -> cifra o payload (action_link + metadados) com
      TokenCipher (mesmo mecanismo do CredentialVault) e enfileira 1 linha em
      outbox_events (status='pending'), invitation -> 'queued'.
      Isso é a MESMA transação de (c) — outbox e membership 'invited' nascem
      juntos ou nenhum dos dois nasce.

3. Worker (Postgres-only, sem Redis):
   claim atômico (FOR UPDATE SKIP LOCKED) -> processing -> chama o adapter de
   e-mail (fake em dev/teste, Resend real só com as duas flags ligadas) ->
   sent (invitation -> 'sent') ou retry/dead_letter conforme attempt_count.

4. Aceitação (frontend clica no link -> verifyOtp com a chave anon -> sessão
   -> Bearer no POST /team/invitations/:id/accept):
   RPC team_invitation_accept: identidade só do JWT (auth.uid()), nunca do
   corpo; confere e-mail/auth_user_id/organização batem com a invitation;
   confere não expirado/não cancelado/ainda não aceito; membership 'invited'
   -> 'active'; invitation -> 'accepted'. Idempotente.
```

### 3.1 Estados de `organization_invitations`

`pending -> provisioning -> ready -> queued -> sent -> accepted`
Desvios: `provisioning|ready -> failed` (retomável — reprocessa),
`queued|sent -> expired` (job de expiração, fora do outbox),
`pending|provisioning|ready|queued|sent -> cancelled` (ação explícita do
ator), `dead_letter` (só herdado do outbox — o convite em si fica `failed`
com o código do outbox).

### 3.2 Estados de `outbox_events`
`pending -> processing -> sent`; `processing -> retry -> pending` (após
backoff) até `attempt_count >= max_attempts` -> `dead_letter`; `cancelled` se
a invitation for cancelada enquanto o evento ainda não foi enviado.

### 3.3 Idempotência

- `idempotency_key` obrigatória em `organization_invitations` (gerada pelo
  cliente ou pelo backend a partir de `hash(organization_id, email_normalizado)`
  quando ausente) — convite ativo duplicado para o mesmo e-mail/organização
  retorna o convite existente (200) em vez de criar um segundo, ou `409` se o
  estado não permitir reenvio automático.
- `outbox_events.idempotency_key` amarrada ao `aggregate_id` (o id do
  convite) + tipo de evento — dois enfileiramentos do mesmo evento colapsam
  em um só via `unique`.
- Reenvio (`POST /team/invitations/:id/resend`) gera um **novo**
  `generateLink` (invalidando o anterior, comportamento nativo confirmado em
  §2) e um **novo** evento de outbox — nunca reenvia o outbox_event antigo
  (ele fica `cancelled` se ainda pendente).

### 3.4 Retries / dead-letter

Exponential backoff com jitter (`available_at = now() + least(max, base * 2^attempt) + jitter`),
`max_attempts` configurável (default pequeno, ex. 5), `dead_letter` terminal
— visível só a papéis autorizados (owner/admin/platform_admin) no frontend,
nunca reprocessado automaticamente depois de `dead_letter`.

### 3.4.1 Risco residual do outbox — entrega AT-LEAST-ONCE, nunca exactly-once

Corrigido/documentado após revisão pós-entrega (achado do usuário): **não é
alegado exactly-once em nenhum lugar desta fase.** Se o provedor de e-mail
aceitar a mensagem (responder 2xx) e o processo cair **antes** de
`team_outbox_mark_sent` persistir, o evento continua `processing` até a
lease expirar (`p_lease_seconds`) e é reclamado por outro worker — que tenta
enviar de novo. Isso pode gerar um e-mail duplicado.

Mitigação real, não cosmética: `resendEmailAdapter` envia o header
`Idempotency-Key` do Resend com o `idempotency_key` do **próprio
outbox_event** (estável entre tentativas do mesmo evento — nunca muda em
retry). Confirmado nos docs do Resend (consultados nesta revisão, não
assumido): "Add an idempotency key to prevent duplicated emails. Should be
unique per API request. Idempotency keys expire after 24 hours." — dedupe
real do lado do provedor, não só um placebo.

O que essa mitigação **não** cobre, documentado sem eufemismo:
- Se o mesmo evento ficar em retry por mais de 24h (bem acima do teto real
  de backoff desta fase — `max_attempts` pequeno — mas não estruturalmente
  impossível se alguém configurar `max_attempts` muito alto), a janela de
  dedupe do Resend expira e a proteção para de valer.
- Cobre só duplicidade **dentro do próprio Resend** — não protege contra
  trocar de provedor no meio do caminho, nem contra uma falha de rede
  exatamente no meio da resposta (e-mail efetivamente enviado, confirmação
  2xx nunca chega ao worker — o Resend não tem como saber que "essa mesma
  tentativa" já foi respondida, então mesmo com a idempotency key uma nova
  tentativa é uma request NOVA pro Resend, que a idempotency key trata como
  duplicata da anterior — isso É coberto; o que não é coberto é o worker
  morrer ENTRE gerar a idempotency key e fazer a primeira tentativa, o que
  não pode acontecer aqui já que a chave é derivada do evento já persistido).

Conclusão honesta: duplicidade é **rara e controlada** (uma janela de até
24h de proteção real do provedor, para retries que na prática esgotam bem
antes disso), não impossível. Aceito para esta fase; eliminá-la de vez
exigiria um registro de "e-mail confirmado enviado" com reconciliação
assíncrona contra a API do provedor — fora do escopo.

### 3.5 Expiração

Dupla camada, nenhuma delegada inteiramente à outra:
1. **Negócio** (`organization_invitations.expires_at`, curta — ex. 72h,
   configurável): checada pela RPC de aceitação ANTES de qualquer chamada ao
   Supabase Auth. Convite expirado nunca chega a tentar `verifyOtp`.
2. **GoTrue** (token do `hashed_token`/`action_link`, seu próprio TTL
   interno, mais o fato confirmado em §2 de que gerar um novo link invalida o
   anterior): defesa em profundidade, não a fonte de verdade do produto.

### 3.6 Segurança do link (resumo — detalhado na ETAPA 7 da implementação)

`action_link`/`hashed_token` **nunca** em plaintext em nenhuma tabela, nunca
em log, nunca em `team_membership_events`-like audit, nunca em
`localStorage` do frontend (o link só existe na URL que o e-mail entrega —
o frontend só manuseia o `token_hash`/`type` da própria URL, do jeito que
`verifyOtp` espera, e não os persiste). Cifrado em `outbox_events.payload`
com o **mesmo mecanismo** do `CredentialVault`/`TokenCipher`
(`src/lib/credentialVault.js`) — AES-256-GCM, AAD amarrando
tabela/registro/campo/organização, envelope versionado
(`e1.<keyVersion>...`), falha fechada.

### 3.7 Dados armazenados

`organization_invitations` nunca guarda o link/token — só metadados
(organização, e-mail, papel pretendido, quem convidou, status, timestamps,
contagem de tentativas, código de erro redigido). O link cifrado vive
**apenas** em `outbox_events.payload` (linha apagada/irrelevante depois de
`sent`, mas não é obrigatório apagá-la nesta fase — ela já está cifrada e sem
grant para `anon`/`authenticated`).

### 3.8 Rollback

`0013_secure_team_invitations.rollback.sql` remove só as 2 tabelas e as
funções desta fase — não toca `memberships`, `users`, `organizations`, nem
reverte o `status='invited'` de nenhuma linha (porque essa fase não faz
`update` em massa: `'invited'` só passa a ser usado por convites NOVOS,
criados depois do cutover desta fase).

## 4. Decisões de projeto e casos de borda a documentar antes da implementação

1. **E-mail para conta já existente e confirmada** (pessoa já é usuária do
   Prognexo, convidada para uma organização nova): `generateLink({type:'invite'})`
   falha para ela (confirmado em §2). Design: a RPC de criação de convite
   detecta que já existe um `auth_user_id`/`users.id` com aquele e-mail e
   **confirmado**; nesse ramo, a invitation pula direto para `ready` sem
   nenhuma chamada de provisionamento de senha — o outbox envia uma
   notificação simples ("você foi adicionado à organização X") com um
   `magiclink`. **Decisão confirmada com o usuário: aceite explícito sempre**
   — a membership nasce `'invited'` mesmo neste ramo (nunca `'active'`
   direto) e só vira `'active'` quando a pessoa efetivamente clicar e
   confirmar o aceite. Um único caminho de estados para os dois casos
   (conta nova ou conta já confirmada) — a única diferença entre os dois
   ramos é qual chamada do Supabase Auth gera o link (`invite` vs
   `magiclink`); o restante da máquina de estados (`invited` → aceite →
   `active`) é idêntico e usa o mesmo RPC de aceitação.
2. **Duas organizações convidando o mesmo e-mail (novo) ao mesmo tempo**:
   `email_exists` do passo `generateLink`/`createUser` é tratado como
   corrida legítima — a segunda RPC detecta o `auth_user_id` já criado pela
   primeira (via lookup por e-mail em `users`/Auth) e reaproveita, nunca
   tenta criar de novo.
3. **users.role permanece travado** em admin/doctor/closer (schema legado);
   o profile nasce com `role='closer'` como hoje — sem mudança de schema.

## 5. Próximo passo

Implementação (migration 0013, RPCs, worker, API, frontend, testes) conforme
o plano acima, seguindo as regras absolutas da FASE 2.7 (sem push/commit/
migration remota/e-mail real). Nenhuma linha de código de produção foi
alterada até este ponto — só leitura, e um probe descartável contra o
Supabase local (apagado, nunca commitado).
