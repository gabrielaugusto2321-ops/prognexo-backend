# 12 — Ordem segura de rollout (FASE 1A / 1A.2)

As migrations **0003, 0004, 0005, 0006 não são aplicadas automaticamente**. O
código foi escrito para funcionar de forma segura ANTES delas (webhooks retornam
`503 webhook_not_ready` em produção; signup falha e compensa) e para ligar
gradualmente depois.

## Dependências

| Migration | Habilita |
| --- | --- |
| `0003` lockdown | fecha `campanhas`/`knowledge_base` para anon/authenticated |
| `0004` users.status | signup público + ativação de conta |
| `0005` webhook_events | idempotência de webhook (WhatsApp + pagamento) |
| `0006` campanha_envios | envio de campanha em lote sem reenvio |

## Sequência

1. **Backup**
   - Snapshot do projeto Supabase (PITR habilitado) + export lógico.
   - Registrar o ponto de retorno (timestamp / número da migration corrente).

2. **Staging**
   - Aplicar `0003 → 0004 → 0005 → 0006` num projeto Supabase de staging com
     dados **sintéticos**.
   - Rodar `migrations/0003_TESTES.md` (anon/authenticated não leem campanhas/kb).
   - `npm test` apontando para staging (ou com mocks) — 100% verde.

3. **Aplicar migrations em produção** (janela de manutenção curta)
   - `0003` primeiro (só revoga acesso — efeito imediato, sem downtime).
   - `0004`: multi-passo, não transforma usuários atuais em pendentes
     (ativos → `active`, inativos → `suspended`).
   - `0005` e `0006`: criação de tabela, sem impacto em dados existentes.

4. **Validar tabelas e permissões**
   - `select` como `anon` em `campanhas`/`knowledge_base` → permission denied.
   - `webhook_events` e `campanha_envios` existem, RLS on, sem grant a anon.
   - `users.status` preenchido em 100% das linhas; constraint ativa.

5. **Publicar o backend** (branch `security/prelaunch-hardening` mergeada)
   - Definir as env vars novas (ver `.env.example` — a atualizar):
     `CORS_ALLOWED_ORIGINS`, `META_APP_SECRET`, `WHATSAPP_WEBHOOK_SIGNATURE_ENFORCED=true`,
     `CAPTCHA_ENABLED` + `CAPTCHA_SECRET`, `LEGACY_CARD_CHECKOUT_ENABLED=false`,
     `PAYMENT_WEBHOOKS_ENABLED=false`, `APP_INSTANCE_COUNT`.
   - O boot **falha explicitamente** se faltar variável obrigatória em produção.

6. **Smoke tests (produção, tráfego controlado)**
   - `GET /health` → 200.
   - Login de um usuário existente → funciona (sessão, `ativo=true`).
   - `GET /leads`, `/deals` (kanban), `/events` → telas carregam com os mesmos
     campos de antes (`esfriando`, `lead_nome`, `produto`, `tipo`).
   - `POST /signup` com e-mail de teste → 202 + e-mail de convite recebido →
     abrir link → definir senha → `POST /activation/complete` → login OK.
   - `GET /webhooks/whatsapp?hub.mode=subscribe...` → challenge ecoado.
   - `POST /webhooks/whatsapp` sem assinatura → 403.
   - CORS de origem não-allowlist → 403.

7. **Publicar o frontend**
   - Signup sem campo de senha; mensagem de "verifique seu e-mail".
   - Tela "Meu plano" trata `checkout_indisponivel`.
   - Sem mudança visual em nenhuma outra tela.

8. **Observar (24–48h)**
   - Erros 5xx por rota, `internal_error` no log com `requestId`.
   - `webhook_events` crescendo; nenhum `webhook_not_ready`.
   - Taxa de 403 em rotas de escrita (esperado subir um pouco — IDOR fechado).
   - Custo de IA por tenant estável.
   - Nenhum segredo no log (grep por `secret=`, `Bearer`, `ccv`).

9. **Rollback**
   - Backend: redeploy da versão anterior (as migrations são compatíveis para
     trás — o código velho ignora `users.status`, `webhook_events`, `campanha_envios`).
   - Migrations: aplicar os `*.rollback.sql` na ordem inversa
     (`0006 → 0005 → 0004 → 0003`). O rollback de `0003` **restaura a exposição
     insegura** — só usar em emergência real e refechar assim que possível.
   - Se o rollback do backend for suficiente, **não** reverter as migrations.

## Ligar os webhooks de pagamento (etapa posterior, fora desta janela)

Por provedor, na ordem: verificar assinatura contra doc oficial + fixtures reais
(ver `WEBHOOKS.md`) → escrever teste com a fixture → migrar a URL do painel para
`X-Prognexo-Webhook-Token` → só então `PAYMENT_WEBHOOKS_ENABLED=true`.

## Múltiplas instâncias

O rate-limit atual é em memória (protege 1 instância). Com `APP_INSTANCE_COUNT>1`
sem store compartilhado, o boot **falha** (`rate_limit_store_misconfigured`).
Antes de escalar horizontalmente: implementar o store Redis
(`configureRateLimitStore()` em `src/middleware/rateLimits.js`).
