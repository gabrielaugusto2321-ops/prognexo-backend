# Webhooks — verificação e estado

> Consulta às fontes: **2026-09-03**. Só a Meta/WhatsApp foi confirmada contra
> documentação/discussões oficiais nesta rodada. Os provedores de pagamento
> usam o mecanismo público conhecido, **mas ainda não foram validados contra a
> documentação oficial vigente + fixtures reais** — por isso o conjunto de
> webhooks de pagamento fica **desligado por padrão em produção**
> (`PAYMENT_WEBHOOKS_ENABLED=false`).

## Gates de produção (todos começam FECHADOS)

| Flag | Default | Efeito |
| --- | --- | --- |
| `WHATSAPP_WEBHOOK_SIGNATURE_ENFORCED` | `true` | rejeita POST sem assinatura HMAC válida |
| `PAYMENT_WEBHOOKS_ENABLED` | `false` | master switch — 503 em todos os webhooks de pagamento até ligar |
| `PAYMENT_WEBHOOKS_ENFORCE_SIGNATURE` | `true` | quando ligado, rejeita assinatura inválida |
| `TICTO_WEBHOOK_ENABLED` | `false` | Ticto não tem assinatura criptográfica — gate adicional |

Além dos flags, os endpoints retornam **503 `webhook_not_ready`** em produção
enquanto a tabela `webhook_events` (migration 0005) não existir — sem
idempotência durável, não se processa (evita cobrança/mensagem duplicada).

## Roteamento por tenant

Header `X-Prognexo-Webhook-Token` (novo). O `?secret=` legado na query ainda é
aceito, com log de depreciação — **migrar as URLs cadastradas nos painéis dos
provedores** e depois remover o fallback.

## Meta / WhatsApp Cloud API — CONFIRMADO

- **Header**: `X-Hub-Signature-256: sha256=<hex>`
- **Algoritmo**: HMAC-SHA256, chave = **App Secret** (`META_APP_SECRET`)
- **Conteúdo assinado**: o **corpo bruto exatamente como recebido**. A Meta assina
  uma representação com unicode/barras escapadas (`\/`, `ä`), então a
  verificação **precisa** usar os bytes originais (capturados no `verify` do
  `express.json`), nunca o JSON re-serializado.
- **Comparação**: timing-safe (`crypto.timingSafeEqual`).
- **Replay**: dedupe por `message.id` da Meta em `webhook_events`.
- **GET de verificação**: `hub.mode=subscribe` + `hub.verify_token` == `WHATSAPP_VERIFY_TOKEN` → ecoa `hub.challenge`.
- Fonte: developers.facebook.com (graph-api / webhooks — "Validating Payloads"),
  e discussões do fórum de desenvolvedores sobre `X-Hub-Signature-256 is incorrect`
  (causa quase sempre = corpo transformado antes da verificação).

## Pagar.me — PENDENTE de verificação oficial

- Implementado: HMAC-SHA1 do corpo bruto no header `X-Hub-Signature`, chave
  `PAGARME_WEBHOOK_SECRET`.
- **A confirmar na doc oficial vigente**: nome exato do header (v4 usa
  `X-Hub-Signature`; versões mais novas podem usar assinatura diferente ou Basic
  Auth), algoritmo (SHA1 vs SHA256), encoding, identificador único do evento.
- Enquanto não confirmado: manter `PAYMENT_WEBHOOKS_ENABLED=false`.

## Kiwify — PENDENTE de verificação oficial

- Implementado: HMAC-SHA1 do corpo bruto, valor em `?signature=` ou header
  `signature`, chave `KIWIFY_WEBHOOK_SECRET`.
- **A confirmar**: local do valor (query vs header), algoritmo, exatamente o que
  é assinado (corpo bruto vs campos concatenados), campo de id do evento
  (`event_id`? `order_id`?), prevenção de replay.

## Hotmart — PENDENTE de verificação oficial

- Implementado: token estático `hottok` (header `X-HOTMART-HOTTOK` ou body),
  comparação timing-safe com `HOTMART_HOTTOK`. **Não é assinatura do payload** —
  só prova de origem.
- **A confirmar**: header exato na versão atual da API, se existe assinatura do
  corpo (algumas versões têm), identificador de evento para idempotência.
- Por não haver assinatura do conteúdo, tratar com o mesmo cuidado do Ticto.

## Ticto — SEM assinatura criptográfica → DESATIVADO por padrão

- A Ticto envia apenas um `token` estático no corpo. Não há HMAC do payload.
- `TICTO_WEBHOOK_ENABLED=false` (default). Ligar exige decisão explícita de
  risco e, idealmente, restrição por IP de origem + validação adicional.

## Antes de declarar qualquer webhook de pagamento "corrigido"

1. Ler a documentação oficial vigente do provedor (header, algoritmo, encoding,
   conteúdo assinado, id do evento, janela anti-replay).
2. Capturar 2–3 payloads reais de teste do painel do provedor (fixtures).
3. Escrever teste que verifica assinatura real contra a fixture.
4. Só então ligar `PAYMENT_WEBHOOKS_ENABLED=true` no ambiente.
