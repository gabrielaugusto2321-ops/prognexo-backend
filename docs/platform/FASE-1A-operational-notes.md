# Notas operacionais — FASE 1A / 1A.2

Ligadas ao hardening da branch `security/prelaunch-hardening`.

## Gates de produção (todos começam FECHADOS)

| Flag | Default | Efeito |
| --- | --- | --- |
| `WHATSAPP_WEBHOOK_SIGNATURE_ENFORCED` | `true` | rejeita webhook WhatsApp sem HMAC válido |
| `PAYMENT_WEBHOOKS_ENABLED` | `false` | 503 em todos os webhooks de pagamento até verificar assinatura de cada provedor (ver `WEBHOOKS.md`) |
| `PAYMENT_WEBHOOKS_ENFORCE_SIGNATURE` | `true` | rejeita assinatura de pagamento inválida |
| `TICTO_WEBHOOK_ENABLED` | `false` | Ticto não tem assinatura criptográfica |
| `LEGACY_CARD_CHECKOUT_ENABLED` | `false` | `/planos/assinar` responde 503 (PAN/CVV não deve trafegar) |
| `CAPTCHA_ENABLED` | `false` | em produção, signup exige captcha configurado (fail-closed) |

Em produção, os webhooks também retornam `503 webhook_not_ready` enquanto a
tabela `webhook_events` (migration 0005) não existir — sem idempotência durável,
não se processa.

## Envio de campanha — processamento destacado (RACE01)

`POST /campanhas/:id/enviar` faz a aquisição atômica `(rascunho|erro) → processando`
e responde **202** na hora; o loop de envio roda destacado do request.

**Risco de reinício do processo Node** — classificação **MÉDIO**:
Se o processo reinicia (deploy, crash, OOM) durante o envio, a campanha fica
`processando`. Mitigação atual: `campanhas.processando_desde` — um `processando`
com mais de 15 min sem concluir é marcado como `erro` no próximo disparo e
retomado; o ledger `campanha_envios` (unique campanha+lead) garante que nenhum
lead recebe a mensagem duas vezes. **Não** há retry automático — depende de
alguém re-disparar a campanha (ou de um cron futuro).

**Migração futura (Fase 2):** substituir o processamento destacado por uma
**job queue persistente** (pgboss sobre o próprio Postgres, ou Redis/BullMQ):
o disparo enfileira um job, um worker processa com retry limitado + DLQ, e o
progresso sobrevive a reinício. O mesmo padrão vale para webhooks e follow-up.
Nenhuma infra nova foi instalada nesta etapa.

O frontend (`Campanhas.jsx`) faz um curto polling de `GET /campanhas` após o
202 até a campanha sair de `processando` — sem mudança visual.

## Rate limit

`express-rate-limit` com **store em memória do processo** — protege **uma**
instância. Com `APP_INSTANCE_COUNT > 1` sem store compartilhado, o boot **falha**
(`rate_limit_store_misconfigured`). Sem `APP_INSTANCE_COUNT` em produção, sobe com
um `warn` explícito. A abstração para Redis está em
`src/middleware/rateLimits.js` (`configureRateLimitStore`).

## Signup / ativação

`POST /signup` → conta sempre `role='doctor'`, `plano='gratuito'`,
`status='pending'`, `ativo=false`. Convite por e-mail (Supabase) define a senha.
`POST /activation/complete` (fora do `requireAuth`, com rate limit próprio):
valida o JWT, exige `email_confirmed_at`, ativa **só a própria conta do token**,
idempotente.

## Env vars

`.env.example` **precisa ser atualizado** com: `CORS_ALLOWED_ORIGINS`,
`APP_INSTANCE_COUNT`, e todos os flags acima. O `env.js` valida em produção e
derruba o boot se faltar variável obrigatória.

## Dependências

`npm audit`: 7 moderate. Não corrigíveis sem breaking:
- `qs` (via express/body-parser/superagent) — advisory inclui a última versão
  publicada (`6.15.3`); sem release corrigido no ramo 6.x ainda.
- `uuid <11.1.1` (via googleapis) — correção exige `googleapis@178` (breaking);
  adiado.
`npm audit fix` (sem `--force`) é no-op — tudo que dava para subir já está na
última versão compatível.
