# FASE 2.8 — Infraestrutura persistente para jobs, quotas e proteção de custo

> Nota de terminologia (herdada das auditorias 23/24): toda menção a
> "Supabase" neste documento significa exclusivamente a instância **local em
> Docker**. Nunca um projeto hospedado.

## 0. Escopo

Esta fase **não** implementa Clinic, novos agentes SDR/BDR nem automações
visuais. Constrói a fundação Postgres-only que o ADR 13
(`13-adr-redis-job-queue.md`) já recomendou: fila de jobs persistente
(`job_queue`), quota/custo por organização (`usage_ledger`, `usage_limits`,
`cost_alerts`), e as interfaces (`JobQueue`, `UsageQuota`, `UsageLedger`) que
permitem trocar a implementação por Redis/BullMQ depois sem tocar nos
handlers — exatamente como o ADR pede. `06-cost-protection.md` e
`07-ai-safety-architecture.md` **não existem** neste repositório; a
proteção de custo de IA hoje vive só em `src/lib/aiLimits.js` (hard caps em
memória, `TenantAiQuota` no-op).

## 1. Trabalhos executados DENTRO de requests HTTP (bloqueando a resposta)

| Local | O quê | Risco |
|---|---|---|
| `src/webhooks/whatsapp.js:190` | `await processarMensagemComIA(...)` — chamada síncrona à Anthropic dentro do handler do webhook da Meta | Meta tem timeout curto de webhook; uma resposta lenta da IA atrasa o ACK ao provedor; nenhuma proteção de custo além dos hard caps de `aiLimits.js` |
| `src/routes/playground.js:67` | `await processarMensagemComIA(...)` | esperado (endpoint interativo de teste), mas mesmo hard cap vale |
| `src/routes/knowledgeBase.js` (ingestão) | `gerarEmbeddings(...)` via Voyage, inline na resposta | upload de base de conhecimento grande trava a resposta; sem quota de embeddings |
| `src/lib/knowledgeChunks.js:100` | `gerarEmbedding(pergunta, 'query')` — chamado a cada busca RAG dentro de `processarMensagemComIA` | acoplado à chamada de IA acima; sem contagem de custo separada |

## 2. Fire-and-forget atuais (disparado sem `await`, sobrevive à resposta HTTP mas não ao reinício do processo)

| Local | O quê | Risco confirmado |
|---|---|---|
| `src/routes/campanhas.js:213` | `processarEnvioCampanha(campanha, ...)` chamado **sem `await`** logo após `res.status(202)` | Se o **processo** morrer (não só a request) no meio do loop `for (const lead of leads)`, a campanha fica com `status='processando'` até alguém chamar `POST /campanhas/:id/enviar` de novo (recuperação é **passiva**, via `staleThreshold` de 15 min checado apenas na PRÓXIMA chamada do endpoint — não há verificação automática/periódica). Duplicidade por lead é evitada pelo `upsert` com `ignoreDuplicates` em `campanha_envios` (unique `campanha_id,lead_id`) — **esse mecanismo já é correto e não precisa ser refeito**, só precisa sobreviver a reinício de verdade (hoje só sobrevive porque o PRÓXIMO request retoma; não há nada rodando entre reinícios). |

## 3. Cron jobs

| Local | O quê |
|---|---|
| `POST /jobs/limpar-leads-esquecidos?secret=` | cron externo (cron-job.org), varre leads parados, HTTP puro, sem fila |
| `POST /jobs/team-invite-outbox?secret=` (FASE 2.7) | mesmo padrão — chama `processOutboxBatch()` uma vez por invocação |

Ambos seguem o MESMO padrão: endpoint protegido por `CRON_SECRET`, processa
um lote e retorna. Nenhum dos dois usa uma fila genérica — são scripts
dedicados. Esta fase não precisa migrá-los (fora do "primeiro corte
vertical" pedido), mas o **worker genérico de `job_queue`** desta fase pode,
no futuro, ser chamado pelo MESMO padrão de cron externo.

## 4. Diferenças entre os três ledgers existentes e a fila genérica nova

| Tabela | Formato | Propósito | Reaproveitável como fila genérica? |
|---|---|---|---|
| `campanha_envios` (0006) | 1 linha por (campanha, lead) | ledger de **destinatário**, idempotência de envio | **Não** — é o "quem já recebeu", não "o que falta processar". Continua sendo a fonte de verdade de destinatário mesmo depois da FASE 2.8 (ver ETAPA 6 do pedido: `campanha_envios` continua ledger). |
| `webhook_events` (0005) | 1 linha por evento externo | idempotência de entrada (nunca processar o mesmo webhook 2x) | **Não** — é dedupe de entrada, não fila de trabalho a fazer. Não tem `status`/retry/claim. |
| `outbox_events` (0013, FASE 2.7) | 1 linha por evento de saída (e-mail) | fila **already-correct** de entrega assíncrona com claim/lease/retry/dead-letter | **Sim, é o protótipo** — `job_queue` desta fase generaliza exatamente esse padrão (`FOR UPDATE SKIP LOCKED`, `claimed_by`/`claimed_at`→`lease_owner`/`lease_expires_at`, `attempt_count`/`max_attempts`, `dead_letter`) para qualquer `job_type`, não só `send_invitation_email`. |

Conclusão: **não existe redundância a remover** — cada tabela resolve um
problema diferente. `job_queue` não substitui `outbox_events`; a ETAPA 6
pede para AVALIAR (não forçar) se o outbox de convite passa a usar o
contrato genérico `JobQueue` por baixo — decisão tomada abaixo em §7.

## 5. Riscos de reinício, duplicação e concorrência (antes desta fase)

- **Campanha**: documentado em §2 — recuperação só na próxima chamada do
  endpoint, nunca automática. TOCTOU já mitigado pela aquisição atômica
  `update ... where status in ('rascunho','erro')` (mesmo padrão de CAS já
  usado em `team_member_change_role`/webhook rotate).
- **IA/embeddings**: nenhuma fila — falha vira erro HTTP direto pro
  cliente, sem retry automático, sem fila de reprocessamento.
- **Rate-limit** (`express-rate-limit`, store em memória): já documentado no
  ADR 13 — por instância, `APP_INSTANCE_COUNT>1` derruba o boot
  (`assertRateLimitStoreReady`). Fora do escopo desta fase (é um store de
  rate-limit HTTP, não uma fila de job) — não confundir os dois.

## 6. Riscos de denial-of-wallet (DoW)

Hoje a ÚNICA proteção de custo real é `aiLimits.js`: hard caps de tamanho de
histórico/mensagem e um semáforo de concorrência **em memória, por
instância** (`MAX_CONCURRENT_PER_TENANT=2`, `MAX_CONCURRENT_GLOBAL=20`).
Isso não é uma quota — é um limitador de rajada. Não existe:
- limite diário/mensal por organização;
- registro de custo estimado por chamada;
- kill switch;
- soft/hard limit com ação diferenciada (warn/throttle/block).

Um ator com uma organização válida pode, hoje, gerar um volume ilimitado de
chamadas à Anthropic/Voyage ao longo do tempo (só limitado pela rajada
instantânea), e um WhatsApp de campanha sem controle de quota por
organização. Esta é exatamente a lacuna que `usage_ledger`/`usage_limits`
fecham.

## 7. O que entra nesta fase e o que fica legado

**Entra (infraestrutura, sem migrar comportamento visível):**
- `job_queue` genérica + `JobQueue` (contrato).
- `usage_ledger`/`usage_limits`/`cost_alerts` + `UsageQuota`/`UsageLedger`
  (contratos).
- Reserva atômica (`reserve → executar → settle/release`) como padrão a ser
  usado por QUALQUER chamada cara futura (WhatsApp de campanha nesta fase;
  IA/embeddings só terão o contrato pronto, não a migração de handler).

**Primeiro corte vertical (único fluxo de comportamento migrado nesta
fase):** envio de campanha (`POST /campanhas/:id/enviar`) passa a enfileirar
1 job por lead em `job_queue` em vez de rodar o loop fire-and-forget em
memória. `campanha_envios` continua exatamente como está — ledger de
destinatário, sem mudança de schema. Quota de WhatsApp (`usage_limits`
categoria `whatsapp_messages`) reservada antes de cada envio.

**Outbox de convite (FASE 2.7) — decisão: NÃO migrar nesta fase.**
Reavaliado por completo (ETAPA 6, item 2, do pedido, que autoriza migrar
"somente se isso reduzir código sem criar regressão"): `outbox_events` tem
uma coluna extra que `job_queue` genérica não tem por padrão
(`aggregate_type`/`aggregate_id` apontando para `organization_invitations`,
+ o RPC composto `team_invitation_attach_and_enqueue` que cria
membership+outbox **na mesma transação**). Reescrever isso sobre o contrato
genérico exigiria ou (a) generalizar `job_queue` com colunas
`aggregate_type`/`aggregate_id` específicas de convite — vazamento de
domínio pra dentro da fila genérica — ou (b) manter uma segunda tabela só
pra esse metadado, o que NÃO reduz código, aumenta risco de regressão numa
fase já commitada e testada (25 testes reais passando) sem necessidade.
**Não migrado.** `outbox_events` continua existindo como está; `job_queue` é
uma fila nova e paralela para os fluxos que ENTRAM nesta fase.

**Não migrado nesta fase (explícito, por instrução do usuário):**
webhook síncrono da Meta, decisões do agente de IA, pagamentos, Google
OAuth, ações clínicas.

## 8. Estratégia de migração compatível

Aditiva, igual ao padrão já usado em 0012/0013: nenhuma tabela/coluna
legada é removida, renomeada ou ganha `NOT NULL`. `campanha_envios` não
muda de schema. O endpoint `POST /campanhas/:id/enviar` muda de
comportamento **só** atrás de `CAMPAIGN_JOB_QUEUE_ENABLED=false` (default) —
com a flag desligada, o código atual (loop fire-and-forget) continua rodando
byte a byte como hoje. Isso significa que, ao contrário da FASE 2.7 (onde o
bloqueador de segurança exigiu **desligar** o caminho legado quando a flag
nova liga), aqui o legado simplesmente não é tocado quando a flag está
off — não há necessidade de um bloqueio equivalente porque não existe uma
segunda porta insegura de enfileirar campanha (só existe o único endpoint
`POST /campanhas/:id/enviar`, cujo comportamento interno o próprio código
decide via flag).

## 9. Impacto das flags

Três flags novas, todas `false` por padrão:
- `PERSISTENT_JOB_QUEUE_ENABLED` — liga a existência da tabela/RPCs sendo
  utilizáveis (o worker só roda se isso estiver ligado).
- `USAGE_QUOTAS_ENABLED` — liga a reserva atômica de quota antes de chamadas
  caras.
- `CAMPAIGN_JOB_QUEUE_ENABLED` — liga o novo caminho de envio de campanha
  via `job_queue` (exige `PERSISTENT_JOB_QUEUE_ENABLED=true`).

Validações de boot a implementar em `src/config/env.js` (mesmo padrão de
`validateTeamInviteOutbox`): `CAMPAIGN_JOB_QUEUE_ENABLED` exige
`PERSISTENT_JOB_QUEUE_ENABLED`; uso de quota externa
(`USAGE_QUOTAS_ENABLED` com ação `block`/`require_approval` real) exige as
tabelas presentes; `APP_INSTANCE_COUNT>1` com `PERSISTENT_JOB_QUEUE_ENABLED=true`
é seguro (Postgres já é o store compartilhado — ao contrário do rate-limit
em memória, isso não precisa derrubar o boot); produção não liga
`CAMPAIGN_JOB_QUEUE_ENABLED` sem `USAGE_QUOTAS_ENABLED` também ligado.

## 10. Impacto Meta

**Nenhum.** O webhook síncrono da Meta (`src/webhooks/whatsapp.js`) está
explicitamente fora do escopo desta fase (ETAPA 6 do pedido). Nenhuma tela,
permissão, escopo ou integração da Meta é tocada.

## 11. Decisão arquitetural — não há nada fora do ADR

O ADR 13 já decide Postgres-only, sem Redis, com interfaces trocáveis. A
única escolha de implementação que o ADR deixa em aberto é "`pg-boss` OU
tabela própria" — decisão tomada aqui: **tabela própria**, no mesmo padrão
já validado e testado da FASE 2.7 (`outbox_events`/`team_outbox_claim`),
em vez de adicionar a dependência `pg-boss` (que tem seu próprio schema
interno, sua própria versão de migração, e um contrato menos alinhado com
os requisitos específicos do pedido — `lease_owner`, heartbeat de lease
para jobs longos, `organization_id`/`unit_id` tenant-scoped, alocação global
com allowlist explícita). Isso não é uma divergência do ADR — é a mesma
decisão ("Postgres-only") com a variante de implementação já provada nesta
base de código. Não há decisão arquitetural pendente que exija parar aqui;
prosseguindo para a ETAPA 3.

## 12. Implementação (ETAPAS 3-8)

Migration `0014_persistent_jobs_and_usage_quotas`: 5 tabelas (`job_queue`,
`usage_reservations`, `usage_ledger`, `usage_limits`, `cost_alerts`) + 11
RPCs, no mesmo padrão da 0013 (RLS deny-all, `revoke all` de
public/anon/authenticated, `security definer`/`search_path=''`, `grant
execute` só a `service_role`, guard `auth.uid()`). `job_queue`: fila
genérica com `FOR UPDATE SKIP LOCKED`, lease (`lease_owner`/
`lease_expires_at`), heartbeat, retry→dead_letter, allowlist de tipo global
via check constraint fixa, payload cifrado opcional (`TokenCipher` da FASE
2.2), teto de 64KB. `usage_reservations`: ciclo `reserved → settled |
released` separado do ledger — chamada externa que não ocorreu nunca vira
custo. `usage_reserve`: advisory lock por org+categoria + `FOR UPDATE` nos
limites, janelas em UTC, `block`/`require_approval` recusam ANTES da chamada
externa, soft alert com dedup. `usage_reservations_sweep_stale`: libera
reserva órfã (job morto/dead_letter).

Contratos (`src/lib/jobQueue.js` / `usageQuota.js` / `usageLedger.js`):
wrappers finos, assinatura JS trocável (ADR 13). `rpcOrThrow` preserva o
código do `raise exception` como `err.code`.

Primeiro corte vertical — campanhas: atrás de `CAMPAIGN_JOB_QUEUE_ENABLED` E
com `campanhas.organization_id` presente, `POST /campanhas/:id/enviar`
enfileira 1 job por lead (destacado, após o 202); `campanha_envios` continua
o ledger de destinatário. Handler reserva quota de `whatsapp_messages` antes
do envio, settle em sucesso, release só se a Meta nem foi chamada, marca
`campanha_envios` 'falhou' em dead_letter. Campanha sem `organization_id`
(antiga / tenant core off) continua no legado mesmo com a flag ligada.

Flags (todas `false`): `PERSISTENT_JOB_QUEUE_ENABLED`, `USAGE_QUOTAS_ENABLED`,
`CAMPAIGN_JOB_QUEUE_ENABLED`. Boot: campaign exige persistent; produção/
staging campaign exige quotas; persistent exige keyring. `APP_INSTANCE_COUNT>1`
NÃO derruba o boot (Postgres já é o store compartilhado; SKIP LOCKED torna N
workers seguros).

## 13. Revisão adversarial (ETAPA 9)

Cobertos e testados: cross-tenant (escopo por parâmetro + `not_found` +
RLS), privilege escalation (`auth.uid()` guard + grants), confused deputy
(AAD amarrada a job/org), duplicação (idempotency keys únicas), corrida
(SKIP LOCKED + advisory lock — 2 workers reais, hard limit nunca ultrapassado
sob concorrência), lease stealing (`lease_owner` conferido), poison job por
loop (`max_attempts`→dead_letter), custo negativo/overflow (checks +
`numeric`), idempotency key do cliente (a rota gera server-side, cliente
nunca escolhe), exposição de payload/logs (respostas só `{id,status}`;
`safeCode()` redige erro), rollback (não-destrutivo), compat `campanha_envios`
(schema intocado), Meta (nenhum arquivo tocado).

**Corrigido nesta revisão:** poison job por TAMANHO — adicionado
`check (length(payload) <= 65536)` + teste.

**Riscos pendentes/parciais (documentados, não bloqueiam):**
1. Sem fairness por organização no `job_claim` (ordena por priority/
   available_at) — uma org com muitos jobs atrasa (não bloqueia) outra.
   Round-robin por org fica para depois.
2. `usage_aggregate` soma `estimated_cost` sem agrupar por `currency` —
   correto hoje (só BRL); corrigir se surgir multi-moeda.
3. Janelas de quota em UTC — a quota diária de org brasileira reseta ~21:00
   BRT. Escolha deliberada; documentar para o operador.
4. Reserva órfã de job dead-lettered conta contra a quota até o sweep de 24h
   (a org não fica bloqueada pra sempre).
5. Crash após a Meta aceitar e antes do settle → possível reenvio no retry
   (o `campanha_envios` unique + a idempotency key do job reduzem, mas não
   é exactly-once — mesma classe da FASE 2.7).

## 14. Desvios do plano (implementador delegado × correções do coordenador)

- Coluna `window` (palavra reservada no Postgres) → renomeada `period`.
- `src/lib/persistentJobsEnv.js` (módulo separado auto-validante) → movido
  para `validateEnv()` em `env.js`; módulo removido.
- `rpc()` embrulhava erro como `${name}_failed` (perdia o código) →
  `rpcOrThrow` preserva `err.code`.
- Mojibake `Token invÃ¡lido` em `jobs.js` → corrigido.
- Enqueue de campanha síncrono antes do 202 → destacado, igual ao legado.
- Zero testes escritos pelo implementador → suíte inteira escrita depois
  (17 RLS reais + 9 contrato/rota + 5 env-guard).

## 15. Revisão 2 (bloqueadores da revisão do usuário) — corrigidos

**BLOQUEADOR 1 — 202 antes da persistência durável.** `POST /campanhas/:id/enviar`
agora faz `await jobQueue.enqueue('campaign.dispatch', …)` (idempotency key
`dispatch:<id>:<processando_desde>`) ANTES do 202; a resposta traz `job_id`.
Falha no enqueue → campanha volta a `erro`, resposta 500. O handler
`campaign.dispatch` (só no worker) pagina os leads (cursor por `leads.id`,
batches de 500, `heartbeat` entre batches), enfileira os `campaign.send_message`
e por fim um `campaign.finalize` (priority -1, +30s). `campaign.finalize`
fecha a campanha quando `campanha_envios` drena; enquanto não, re-agenda a
60s; após ~3.3h presa → dead_letter → campanha `erro` recuperável. Os
handlers de `send` não tocam mais no status da campanha.

**BLOQUEADOR 2 — segredo na query string.** `/jobs/campaign-outbox` agora
usa `requireJobRunnerAuth` (`src/lib/jobRunnerAuth.js`): só header
(`Authorization: Bearer <JOB_RUNNER_SECRET>` ou `X-Prognexo-Job-Token`),
`crypto.timingSafeEqual`, `?secret=` rejeitado, 401 genérico, token redigido
no log (`redactPaths` + serializer que strippa a query). Novo env
`JOB_RUNNER_SECRET`, exigido no boot com `PERSISTENT_JOB_QUEUE_ENABLED`.

**BLOQUEADOR 3 — fallback legado escapando das quotas.** Com
`CAMPAIGN_JOB_QUEUE_ENABLED=true`, campanha sem `organization_id` →
`409 tenant_backfill_required` ANTES de qualquer WhatsApp e ANTES da
aquisição atômica. Nunca cai no legado. Flag OFF: legado 100% preservado.
Script `scripts/check-campaigns-without-org.js` (read-only, fail closed,
recusa `*.supabase.co`, só imprime contagem + uuids, exit 2 com pendências)
— rodar `APP_ENV=staging node scripts/check-campaigns-without-org.js` antes
de ligar a flag.

## 16. Revisão 3 (corrida de atomicidade job ↔ campanha_envios) — corrigida

O dispatch fazia `queue.enqueue` + `upsert campanha_envios` como duas
operações separadas — não atômico: um worker podia claimar o send antes de
`campanha_envios` existir, ou o dispatch podia sobrescrever um estado
terminal com `'enviando'`.

Corrigido com **`campaign_recipient_enqueue(p_job_id, p_organization_id,
p_campaign_id, p_lead_id, p_payload_encrypted)`** — RPC transacional
(`SECURITY DEFINER`, `search_path=''`, só `service_role`, `auth.uid()`
guard). Numa única transação: valida cross-tenant (campanha pertence à org
informada; lead pertence ao mesmo doctor da campanha), deriva a
`idempotency_key` server-side (`<campanha>:<lead>` — NUNCA parâmetro),
cria/localiza `campanha_envios` E `job_queue` juntos (as duas linhas
visíveis só após o commit), vincula via nova coluna `campanha_envios.job_id`
(nullable, aditiva), e devolve `{job_id, ledger_id, created, terminal,
envio_status}` sem expor o payload cifrado. **Estado terminal**
(`enviado`/`falhou`/…) → devolve `terminal:true`, não recria job, não
rebaixa (reenvio manual futuro precisa de operação/chave própria). O
dispatch agora chama SÓ essa RPC por destinatário
(`JobQueue.enqueueCampaignRecipient`). 7 testes RLS reais provam:
atomicidade, falha pré-commit deixa zero linha nas duas tabelas, dois
dispatches concorrentes → exatamente 1 par, terminal nunca rebaixado
(`enviado`/`falhou`), cross-tenant lead/campanha rejeitado, idempotency key
não-parametrizável.

Migration 0014 atualizada (função + coluna), rollback dropa só esses dois
objetos, cópia CLI byte-idêntica, db reset + rollback + forward revalidados.
