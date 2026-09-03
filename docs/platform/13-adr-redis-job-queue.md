# 13 — ADR: store compartilhado e fila de jobs persistente

**Status:** proposto (FASE 1B.1) — **nenhuma infra criada nesta fase**.
**Decisão:** recomendada abaixo; integração completa fica para uma fase posterior, com aprovação.

## Contexto

Hoje, três mecanismos vivem em memória do processo e não sobrevivem a reinício
nem escalam para múltiplas instâncias:

| Mecanismo | Onde | Limitação atual |
| --- | --- | --- |
| Rate-limit | `src/middleware/rateLimits.js` (`express-rate-limit`, store default) | conta por instância; `APP_INSTANCE_COUNT>1` já derruba o boot |
| Concorrência / hard caps de IA | `src/lib/aiLimits.js` (`Map` + contador) | por instância; sem quota persistente por tenant |
| Envio de campanha | `src/routes/campanhas.js` (`processarEnvioCampanha` destacado) | reinício deixa a campanha `processando`; retomada manual (mitigada por `processando_desde` + ledger `campanha_envios`) |
| Idempotência de webhook | `webhook_events` (Postgres) | **já persistente** — ok |
| Ativação / OAuth state | `src/lib/oauthState.js` (`Map`) | por instância; TTL 10 min |

Requisitos que uma solução precisa cobrir: rate-limit compartilhado, quota
persistente de IA por tenant, processamento de campanha resiliente a reinício,
retries limitados, dead-letter queue, idempotência, recuperação após restart,
custo operacional baixo.

## Opções avaliadas

### A. Postgres-only (pg-boss / fila na própria base)
- **Store de rate-limit**: `@acpr/rate-limit-postgresql` ou tabela própria.
- **Fila**: `pg-boss` (fila, agendamento, retries, DLQ, arquivamento) sobre o Postgres do Supabase.
- **Quota de IA**: tabelas `usage_quotas` / `usage_events` (já previstas em `04-target-data-model.md`).
- **Prós**: zero infra nova (usa o Supabase que já existe); um só backup; transações; sem custo adicional; opera em qualquer host.
- **Contras**: throughput menor que Redis (ok para o volume atual — dezenas de msgs/min); carga extra no Postgres; `pg-boss` faz polling (latência de segundos, aceitável para campanha/follow-up).

### B. Redis + BullMQ
- **Store de rate-limit**: `rate-limit-redis`.
- **Fila**: BullMQ (jobs, retries com backoff, DLQ nativa, rate-limiting de fila, repeatable jobs, eventos).
- **Quota de IA**: contadores atômicos no Redis + persistência periódica no Postgres.
- **Prós**: baixa latência; primitivas de fila maduras; escala horizontal trivial.
- **Contras**: **um serviço novo** (Redis gerenciado — Upstash/Redis Cloud) → custo mensal + ponto de falha + backup/retention próprios + mais um segredo para rotacionar; Upstash serverless tem custo por request que pode surpreender sob carga.

### C. Managed queue do provedor (ex.: QStash / SQS / Cloud Tasks)
- **Prós**: sem servidor para manter; retries e DLQ gerenciados.
- **Contras**: acopla ao provedor; webhooks de entrada exigem endpoint público assinado (mais superfície); rate-limit e quota ainda precisam de outra solução; latência de rede por job.

## Comparação

| Critério | A. Postgres/pg-boss | B. Redis/BullMQ | C. Managed queue |
| --- | --- | --- | --- |
| Infra nova | **nenhuma** | Redis gerenciado | serviço externo |
| Custo operacional | ~0 | $ (mensal + por uso) | $ (por request) |
| Rate-limit compartilhado | sim (lib pg) | sim (nativo) | não (precisa outra coisa) |
| Quota persistente de IA | sim (tabelas) | sim (Redis+flush) | não |
| Campanha resiliente a restart | sim | sim | sim |
| Retries + DLQ | sim (pg-boss) | sim (BullMQ) | sim |
| Latência de job | segundos | ms | rede |
| Escala horizontal | boa até volume médio | ótima | ótima |
| Complexidade added | baixa | média | média |
| Backup / retention | já coberto pelo Supabase | próprio do Redis | do provedor |

## Decisão recomendada

**Adotar a Opção A (Postgres-only: `pg-boss` + store de rate-limit em Postgres),
com uma camada de abstração que permita trocar para Redis (Opção B) sem mudar os
handlers**, caso o volume cresça a ponto de justificar.

Racional: o volume atual é baixo; a Opção A elimina um serviço novo, um custo
mensal, um ponto de falha e um segredo a rotacionar — mantendo backup e
retention no mesmo lugar. BullMQ/Redis passa a valer a pena quando (a) o volume
de jobs/min entrar em centenas sustentadas, ou (b) precisarmos de latência
sub-segundo em automações. A abstração (`JobQueue`, `RateLimitStore`,
`UsageQuota`) torna essa migração um trabalho localizado.

## Interfaces a introduzir (fase posterior, não agora)

```ts
interface JobQueue {
  enqueue(type: string, payload: unknown, opts?: { runAt?: Date; idempotencyKey?: string; maxAttempts?: number }): Promise<string>;
  process(type: string, handler: (payload: unknown) => Promise<void>, opts?: { concurrency?: number }): void;
  // DLQ: jobs que esgotaram maxAttempts ficam em estado 'failed' consultável.
}

interface RateLimitStore { /* interface Store do express-rate-limit v7 */ }

interface UsageQuota {
  check(orgId: string, metric: 'ai_tokens' | 'wa_messages'): Promise<{ allowed: boolean; remaining: number | null }>;
  record(orgId: string, metric: string, amount: number, cost?: number): Promise<void>;
}
```

Pontos de troca já preparados no código:
- `src/middleware/rateLimits.js` — `store` (comentário indica onde plugar).
- `src/lib/aiLimits.js` — `TenantAiQuota` (no-op hoje).
- `src/routes/campanhas.js` — `processarEnvioCampanha` (vira `queue.enqueue('campaign.send', ...)`).
- `src/lib/oauthState.js` — `Map` vira store compartilhado.
- `src/lib/readiness.js` — pattern de gate por readiness de tabela.

## Não fazer agora
Instalar Redis, `pg-boss`, BullMQ ou qualquer serviço; criar tabelas de fila;
migrar os handlers. Isso é uma fase própria, com aprovação.
