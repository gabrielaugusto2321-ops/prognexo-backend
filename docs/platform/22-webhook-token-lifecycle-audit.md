# FASE 2.4 — Auditoria do `webhook_token` (antes de qualquer implementação)

Base: backend `3554391`, frontend `5b970a3`, branch `security/webhook-token-lifecycle`.
Complementa (não substitui) [22-webhook-token-rotation-design.md](22-webhook-token-rotation-design.md)
(desenho da FASE 2.3) e [20-token-encryption-rollout.md](20-token-encryption-rollout.md).

## 1. Quem cria `integrations.webhook_token`

- **O banco.** `baseline.sql`:
  `webhook_token text default encode(extensions.gen_random_bytes(16), 'hex')`
  → 32 chars hex (16 bytes) gerados **no `INSERT` da linha**.
- **Nenhum código de aplicação gera** `webhook_token` hoje. A linha é criada em
  `GET /integrations` (`routes/integrations.js`), que faz `upsert({ doctor_id, gateway })`
  para os 5 gateways (`kiwify, hotmart, ticto, pagarme, whatsapp`) — o `default` do banco
  preenche o token.
- `CredentialVault.buildIntegrationCredentialPatch` **sabe** cifrar/indexar um
  `webhook_token` se receber um, mas **nada chama isso com `webhook_token`** em produção
  (só testes). Ou seja: o token de hoje é sempre o `gen_random_bytes(16)` em **plaintext**.

## 2. Quais provedores usam o token

| provedor | usa `webhook_token`? | como resolve o tenant | assinatura adicional |
|---|---|---|---|
| **Pagar.me** | **SIM** | `resolveDoctorFromToken('pagarme', token)` | HMAC-SHA1 do corpo (`PAGARME_WEBHOOK_SECRET`) |
| **Kiwify** | **SIM** | `resolveDoctorFromToken('kiwify', token)` | HMAC-SHA1 do corpo (`KIWIFY_WEBHOOK_SECRET`) |
| **Hotmart** | **SIM** | `resolveDoctorFromToken('hotmart', token)` | `hottok` estático (`HOTMART_HOTTOK`) |
| **Ticto** | **SIM** | `resolveDoctorFromToken('ticto', token)` | sem assinatura — gate `TICTO_WEBHOOK_ENABLED` + `TICTO_TOKEN` |
| **WhatsApp Cloud API** | **NÃO** | `value.metadata.phone_number_id` → `integrations.external_id` → `doctor_id` | assinatura `X-Hub-Signature-256` (`META_APP_SECRET`) |

O `SELECT` em `src/webhooks/whatsapp.js:70` inclui `webhook_token` na lista de colunas,
mas **o valor nunca é lido** (linha 80 lê só `['access_token']`; a resolução de tenant é
por `phone_number_id`). É coluna morta no SELECT — candidata a remoção (opcional).

## 3. Quais rotas recebem o token

| rota | recebe o token? | de onde |
|---|---|---|
| `POST /webhooks/pagarme` `\|` `/kiwify` `\|` `/hotmart` `\|` `/ticto` (via `paymentFactory`) | **SIM** (entrada) | header `X-Prognexo-Webhook-Token` (preferido) **ou** `?secret=<token>` na query (**legado, deprecado** — `logger.warn` "Deprecated webhook query token used") |
| `POST /webhooks/whatsapp` | não | — |
| `GET /webhooks/whatsapp` (handshake Meta) | não | `hub.verify_token` = `WHATSAPP_VERIFY_TOKEN`, **não** é o `webhook_token` |
| `GET /integrations` | **não devolve** | `stripSecrets` remove `webhook_token`, `webhook_token_encrypted`, `webhook_token_lookup`; devolve só `webhook_token_configurado` (boolean) |
| `PATCH /integrations/whatsapp` | não | só `external_id` + `access_token` |
| `POST /integrations/whatsapp/embedded-callback` | não | `code`, `waba_id`, `phone_number_id` |

## 4. Onde o token aparece (query / header / frontend / logs / banco)

| canal | estado atual |
|---|---|
| **query string** | **INBOUND legado**: `?secret=<token>` aceito em `paymentFactory` (provedor → nós). `req.query.secret` é redigido no logger. **OUTBOUND**: `frontend/src/pages/Integrations.jsx:92` monta `${apiUrl}/webhooks/${gateway}?secret=${webhookToken}` com `integ.webhook_token` — que a API **não retorna mais** → a URL sai com `secret=undefined`. **Gap.** |
| **header** | `X-Prognexo-Webhook-Token` (inbound, preferido). Nunca enviado pelo nosso frontend. |
| **frontend** | `Integrations.jsx` **lê `integ.webhook_token`** (linha 292) — sempre `undefined` desde o 0008. `client.js` só tem `webhook_token` em fixtures `USE_MOCK` (`demo-*-token`). |
| **logs** | `logger.js` redige `webhook_token`, `*.webhook_token`, `webhook_token_encrypted`, `webhook_token_lookup`, `req.query.secret`, `req.query.token`. |
| **banco** | `integrations.webhook_token` (plaintext, `gen_random_bytes(16)` hex). Colunas `webhook_token_encrypted` / `webhook_token_lookup` (0009) existem mas **vazias** em produção (nenhuma escrita passou pelo Vault ainda). RLS: browser **sem SELECT** em `integrations` (0009). View `integration_status`: só `has_webhook_token` (boolean). |

## 5. Relação com WhatsApp / Embedded Signup / Meta

**NENHUMA.** Comprovado por busca em todo `src/`:

- `webhook_token` **não** aparece em `src/lib/embeddedSignup.js` (0 ocorrências);
- **não** é usado em `registerPhoneNumber` nem `subscribeAppToWaba`;
- **não** é usado no handshake `GET /webhooks/whatsapp` (`hub.verify_token` = `WHATSAPP_VERIFY_TOKEN`);
- **não** é usado na verificação de assinatura do webhook WhatsApp (`X-Hub-Signature-256` / `META_APP_SECRET`);
- o webhook WhatsApp resolve tenant por `phone_number_id`, sem tocar em `webhook_token`;
- o único consumidor de `webhook_token` é `salesWebhook.resolveDoctorFromToken` → **exclusivamente** os 4 gateways de pagamento.

**Conclusão: `webhook_token` é 100% isolado da Meta.** Rotacioná-lo não afeta
Embedded Signup, escopos, permissões, callbacks, handshake, assinatura Meta nem
`META_SYSTEM_USER_TOKEN`.

## 6. Como o token é validado hoje

`paymentFactory.js` → `resolveDoctorFromToken(gateway, token)` → `salesWebhook.js` →
`CredentialVault.resolveIntegrationByWebhookToken({ gateway, token })`:

- **cripto DESLIGADA** (`TOKEN_ENCRYPTION_ENABLED != 'true'` — default hoje):
  `SELECT id, doctor_id FROM integrations WHERE gateway = $1 AND webhook_token = $2` (igualdade direta).
- **cripto LIGADA**: `digest = HMAC-SHA256(TOKEN_LOOKUP_HMAC_KEY, token.trim())` (base64url, 43 chars);
  `SELECT ... WHERE gateway = $1 AND webhook_token_lookup = $digest`; para cada candidato
  **descriptografa `webhook_token_encrypted` e confirma com `crypto.timingSafeEqual`**;
  fallback para igualdade plaintext se `TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ`.
- token vazio / não encontrado → `doctorId = null` → `paymentFactory` responde **401**.
- normalização: `String(token).trim()` (`TokenLookup.normalize`).

## 7. Impacto de rotação sobre URLs já configuradas

Trocar o `webhook_token` de uma integração de pagamento:

1. **invalida** a URL/segredo cadastrado no painel do provedor (Pagar.me/Kiwify/Hotmart/Ticto);
2. webhooks recebidos com o token antigo → `resolveDoctorFromToken` retorna `null` → **401**
   → o evento **não é processado** (nenhuma cobrança/fechamento perdido silenciosamente —
   o `webhook_events` só registra após resolver o tenant);
3. o médico precisa **reconfigurar** a URL (header `X-Prognexo-Webhook-Token: <novo>`) no
   painel de **cada** gateway ativo;
4. `webhook_token_lookup` é recalculado junto (via `CredentialVault`);
5. **zero impacto** em WhatsApp/Meta (item 5).

## 8. Como `CredentialVault` e blind index são usados

- `CredentialVault.buildIntegrationCredentialPatch({ values: { webhook_token } })` →
  grava `webhook_token_encrypted` (AES-256-GCM, AAD `integrations\|<id>\|webhook_token\|doctor:<id>\|<gateway>`)
  + `webhook_token_lookup` (`TokenLookup.blindIndex`) + `webhook_token` só se `DUAL_WRITE`.
- Índice: `integrations_webhook_token_lookup_idx` em `(gateway, webhook_token_lookup)`.
- Constraint `integrations_webhook_lookup_fmt`: `^[A-Za-z0-9_-]{43,44}$`.
- `resolveIntegrationByWebhookToken` já trata colisão de digest (confirma com `timingSafeEqual`).
- Trocar `TOKEN_LOOKUP_HMAC_KEY` invalida todos os `webhook_token_lookup` (operação de
  manutenção separada, não uma rotação por tenant).

## 9. Tabela-decisão

| provedor / item | rota | origem do token | armazenamento | lookup | transporte | exposição atual | impacto rotação | relação Meta | decisão |
|---|---|---|---|---|---|---|---|---|---|
| Pagar.me | `POST /webhooks/pagarme` | `gen_random_bytes(16)` (banco) | `integrations.webhook_token` (plaintext) + `_encrypted`/`_lookup` vazios | `webhook_token` eq / `webhook_token_lookup` (cripto on) | header `X-Prognexo-Webhook-Token` ou `?secret=` legado (inbound) | não devolvido por API; redigido em log; sem SELECT no browser | invalida URL do painel Pagar.me | **nenhuma** | **IMPLEMENTAR rotação** |
| Kiwify | `POST /webhooks/kiwify` | idem | idem | idem | idem | idem | invalida URL Kiwify | **nenhuma** | **IMPLEMENTAR rotação** |
| Hotmart | `POST /webhooks/hotmart` | idem | idem | idem | idem | idem | invalida URL Hotmart | **nenhuma** | **IMPLEMENTAR rotação** |
| Ticto | `POST /webhooks/ticto` | idem | idem | idem | idem | idem | invalida URL Ticto | **nenhuma** | **IMPLEMENTAR rotação** |
| WhatsApp | `POST /webhooks/whatsapp` | n/a (não usa `webhook_token`) | n/a | n/a — resolve por `phone_number_id` | n/a | `webhook_token` sai na col. do SELECT mas não é lido | rotação **não afeta** WhatsApp | **nenhuma** (usa `phone_number_id` + `META_APP_SECRET`) | **NÃO ROTACIONAR aqui** — opcional: tirar `webhook_token` do SELECT morto |
| `Integrations.jsx` `buildUrl(...secret=integ.webhook_token)` | frontend | — | — | — | query string outbound | monta `?secret=undefined` (API não devolve o token) | — | **nenhuma** | **CORRIGIR** — URL sem secret + ação de rotação com retorno único |
| `client.js getLeads` `currentUser` na query | `GET /leads` | — | — | — | `?currentUser=[object Object]` | objeto de contexto interno vira query param | — | **nenhuma** | **CORRIGIR** — serializador com allowlist |
| `?secret=` legado no `paymentFactory` | `POST /webhooks/*` | — | — | — | query string inbound | aceito + `logger.warn` | — | **nenhuma** | **manter aceito** (compat com quem já cadastrou), mas frontend para de gerar URLs com `?secret=` |

## 10. Veredito

- **`webhook_token` NÃO tem relação com a Meta** — comprovado (item 5).
- **ETAPA 3 (fix `currentUser`)**: implementar — sem relação com token/Meta.
- **ETAPA 4 (ciclo de rotação)**: implementar — Meta isolada.
- Necessária **migration 0011 aditiva**: hoje não há `webhook_token_rotated_at`, nem
  fingerprint não-reversível, nem tabela de auditoria da rotação. O `webhook_token`
  atual (default do banco) permanece válido até a primeira rotação.

## 11. Contrato implementado (FASE 2.4)

`POST /integrations/:id/webhook-token/rotate` — body `{ "confirm": true }` (`.strict()`).

- **Autorização** (`ROTATE_ROLES`): `organization_owner`, `organization_admin`;
  `platform_admin` só quando a integração tem `organization_id`. `closer`,
  `professional`, `receptionist`, `financial`, `viewer` → **403**.
- integração de outro tenant / inexistente → **404** (mesma resposta → sem enumeração).
- `gateway === 'whatsapp'` → **400 `not_applicable_for_whatsapp`** — WhatsApp não usa
  `webhook_token`; rotacionar não faria nada e a decisão é **não tocar** nessa integração.
- `confirm` ausente/false → **400 `confirmation_required`**.
- body com `webhook_token` / `organization_id` / `doctor_id` / `role` / `user_id` → **400**
  (schema `.strict()`; nenhum desses vem do body).
- **Idempotência**: se `webhook_token_rotated_at` < 15 s → **409 `rotation_too_recent`**
  (devolve `has_webhook_token`, `webhook_token_fingerprint`, `rotated_at`; **não** o token).
- **Rate-limit**: `webhookTokenRotateLimiter` — 5/min por usuário → **429**.
- **Geração**: `crypto.randomBytes(32)` → base64url (43 chars). `fingerprint` =
  `sha256(token).hex.slice(0,12)` (não-reversível).
- **Persistência**: `CredentialVault.buildWebhookTokenRotation` → `buildIntegrationCredentialPatch`
  (respeita `TOKEN_ENCRYPTION_ENABLED` / `DUAL_WRITE`; gera `webhook_token_lookup`) +
  `webhook_token_rotated_at` + `webhook_token_fingerprint`. O token anterior deixa de
  resolver a partir do `UPDATE`.
- **Concorrência (CAS)** — achado F3: o token é gerado **em memória** e só chega ao banco
  via um `UPDATE` condicional que casa `id + gateway + organization_id +
  webhook_token_rotated_at + webhook_token_fingerprint` com o estado observado na leitura.
  Sob `READ COMMITTED`, duas requisições verdadeiramente simultâneas serializam no lock da
  linha; a segunda re-avalia o `WHERE` contra a linha já rotacionada e afeta **0 linhas** →
  **409 `rotation_conflict`**, sem devolver o token gerado, re-consultando só
  `webhook_token_fingerprint` / `rotated_at`. O `fingerprint` (sha256 de token aleatório,
  único por rotação) fecha a janela de ABA. Prova de nível de banco:
  `test/rls/webhook-token-lifecycle.rls.test.js` ("CAS atômico").
- **Retorno único**: `{ webhook_token, webhook_token_fingerprint, webhook_url, header, rotated_at, warning }`.
  `GET /integrations` **nunca** devolve `webhook_token` (só `webhook_token_configurado` +
  `webhook_token_fingerprint`). **Não há endpoint para revelar de novo.**
- **Auditoria**: `webhook_token_events` (`integration_id, organization_id, actor_user_id,
  gateway, action, result, detail`) — `result in ('success','denied','error','conflict')`
  (`conflict` adicionado na 0011 para registrar o perdedor do CAS). `detail` guarda só o
  `fingerprint`, **nunca** o token. Vencedor → `success`; perdedor do CAS → `conflict`;
  erro de banco no `UPDATE` → `error`. Falha da própria auditoria (insert rejeitado) é
  logada de forma redacted e **não** derruba a resposta nem trava a conexão.
- **Meta**: nenhum arquivo de `embeddedSignup` / `registerPhoneNumber` / `subscribeAppToWaba`
  / handshake / assinatura foi tocado. `webhook_token` continua isolado.
