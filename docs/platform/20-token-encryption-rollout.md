# FASE 2.2 — Criptografia de tokens em repouso: inventário e rollout

Complementa o [ADR 19](19-adr-token-encryption.md) com a implementação concreta.

## 1. Inventário de credenciais persistidas

| campo | tabela | origem | quem grava | quem lê | busca por igualdade | exposição hoje | cripto | migração |
|---|---|---|---|---|---|---|---|---|
| `access_token` | `integrations` | médico cola o token permanente da Meta | `PATCH /integrations/whatsapp` (`routes/integrations.js`) | `webhooks/whatsapp.js`, `routes/campanhas.js`, `routes/conversations.js` | não | 0008 revogou SELECT do browser; `/integrations` devolve só `access_token_configurado` | AES-256-GCM, AAD `integrations\|id\|access_token\|doctor:<id>\|<gateway>` | dual-write + script 0009 |
| `webhook_token` | `integrations` | default do banco (`gen_random_bytes(16)`) | nunca escrito pelo app (default) / `CredentialVault` se escrito | `lib/salesWebhook.js:resolveDoctorFromToken` (roteia webhook de pagamento por tenant) | **sim** (`.eq('webhook_token', token)`) | idem acima | AES-256-GCM **+ blind index HMAC-SHA256** em `webhook_token_lookup` | dual-write + script; digest calculado no backfill |
| `refresh_token` | `google_tokens` | Google OAuth callback | `GET /auth/google/callback` (`routes/googleAuth.js`) | `lib/googleCalendar.js:getClientParaUsuario` | não | 0008 revogou SELECT do browser; `/auth/google/status` devolve só `{conectado}` | AES-256-GCM, AAD `google_tokens\|user_id\|refresh_token\|user:<id>\|google` | dual-write + script |
| `access_token` | `google_tokens` | Google OAuth callback | idem | (gravado, hoje não relido — só o refresh_token é usado) | não | idem | AES-256-GCM | dual-write + script |

**Segredos NÃO persistidos no banco** (ficam no ambiente de deploy, fora do escopo desta fase):
`META_APP_SECRET`, `META_SYSTEM_USER_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `ANTHROPIC_API_KEY`,
`VOYAGE_API_KEY`, `CRON_SECRET`, `CAPTCHA_SECRET`, `GOOGLE_CLIENT_SECRET`, `ASAAS_API_KEY`,
`RESEND_API_KEY`, `PAGARME_WEBHOOK_SECRET`, `KIWIFY_WEBHOOK_SECRET`, `HOTMART_HOTTOK`, `TICTO_TOKEN`.

### Como `webhook_token` resolve o tenant

`paymentFactory.js` lê o header `X-Prognexo-Webhook-Token` (ou `?secret=` legado) e chama
`resolveDoctorFromToken(provider, token)` → `CredentialVault.resolveIntegrationByWebhookToken`:

- **cripto desligada:** `SELECT doctor_id ... WHERE gateway = $1 AND webhook_token = $2` (como hoje).
- **cripto ligada:** calcula `blindIndex(token)` (HMAC-SHA256 com `TOKEN_LOOKUP_HMAC_KEY`),
  `SELECT ... WHERE gateway = $1 AND webhook_token_lookup = $digest`, e para cada candidato
  **descriptografa `webhook_token_encrypted` e confirma com `timingSafeEqual`** antes de aceitar
  (trata colisão de digest e nunca aceita só pelo digest).
- **janela de migração (`ALLOW_PLAINTEXT_READ=true`):** se não houver linha com lookup,
  cai para a igualdade em `webhook_token` plaintext.

Trocar `TOKEN_LOOKUP_HMAC_KEY` invalida todos os `webhook_token_lookup` — exige recalcular
os digests (re-rodar o script de migração após limpar a coluna).

## 2. Arquitetura criptográfica

- **Algoritmo:** AES-256-GCM, IV aleatório de 12 bytes por operação, tag de 16 bytes. `node:crypto` puro.
- **Envelope:** `e1.<keyVersion>.<iv_b64url>.<ciphertext_b64url>.<tag_b64url>`
  - `e1` = versão do **envelope** (formato/algoritmo).
  - `<keyVersion>` = versão da **chave** no keyring, ex. `v2`. Campos separados — nunca confundidos.
- **AAD obrigatória** (`buildAad`): `pgx` + `v1` + tabela + id do registro + campo + escopo
  (`doctor:<id>` ou `user:<id>`) + provider. Impede mover ciphertext entre campos/registros/tenants.
- **Falha fechada:** envelope malformado, versão desconhecida, chave ausente, tag inválida ou
  AAD divergente **lançam**. `decrypt` nunca devolve plaintext parcial nem cai para a coluna plaintext.
- **Nada determinístico:** duas cifragens do mesmo valor geram envelopes diferentes (IV novo).
- **Blind index:** `HMAC-SHA256(TOKEN_LOOKUP_HMAC_KEY, token.trim())` em base64url. Chave
  dedicada, independente das chaves AES. Comparação final sempre `crypto.timingSafeEqual`.

## 3. Keyring e variáveis

| var | formato | regra |
|---|---|---|
| `TOKEN_ENCRYPTION_KEYRING` | JSON `{"v1":"<base64 32B>", ...}` | parser rejeita JSON inválido, objeto vazio, rótulo fora de `^v\d+$`, chave ≠ 32 bytes, rótulo duplicado |
| `TOKEN_ENCRYPTION_ACTIVE_KEY` | `^v\d+$` | precisa existir no keyring; é a versão usada para gravar |
| `TOKEN_LOOKUP_HMAC_KEY` | base64 ≥ 32 bytes | independente das chaves AES |
| `TOKEN_ENCRYPTION_ENABLED` | `true`/`false` (default `false`) | `false` = a camada só repassa plaintext |
| `TOKEN_ENCRYPTION_DUAL_WRITE` | `true`/`false` (default `false`) | exige `ENABLED=true`; grava ciphertext **e** plaintext |
| `TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ` | `true`/`false` (default `false`) | leitura cai para plaintext só quando **não há** ciphertext |

Boot: com `ENABLED=true`, config ausente/inválida **derruba o boot**. `DUAL_WRITE=true` sem
`ENABLED=true` derruba o boot. Em produção, `ALLOW_PLAINTEXT_READ=true` ou `DUAL_WRITE=true`
emitem **aviso** no stderr (combinação transitória). Chaves nunca vão a log (redação em `logger.js`).

## 4. Estados permitidos por etapa do rollout

| etapa | ENABLED | DUAL_WRITE | ALLOW_PLAINTEXT_READ | estado do banco |
|---|---|---|---|---|
| 0. hoje (default) | false | false | false | só plaintext |
| 1. habilita camada (staging/local) | true | true | true | grava ciphertext+plaintext; lê ciphertext, senão plaintext |
| 2. backfill | true | true | true | roda `scripts/migrate-token-encryption.js --apply` até 0 pendências |
| 3. corta leitura de plaintext | true | true | **false** | toda leitura exige ciphertext válido (falha fechada) |
| 4. corta escrita de plaintext | true | **false** | false | só ciphertext é escrito; plaintext antigo permanece |
| 5. limpeza (FASE futura) | true | false | false | migration remove as colunas plaintext |

Nunca há duas fontes de verdade simultâneas: em dual-write o ciphertext é a fonte e o
plaintext é só rede de segurança para rollback.

## 5. Migration 0009

`migrations/0009_token_encryption.sql` (+ `.rollback.sql`, + cópia CLI). Aditiva:
- `integrations`: `access_token_encrypted`, `webhook_token_encrypted`, `webhook_token_lookup`, `token_encryption_migrated_at`
- `google_tokens`: `access_token_encrypted`, `refresh_token_encrypted`, `token_encryption_migrated_at`
- CHECK de formato do envelope / do digest; índice parcial em `(gateway, webhook_token_lookup)`; **nenhum índice em ciphertext**
- reafirma `revoke select ... from anon, authenticated`; nenhuma função SQL recebe chave
- views `google_connection_status` / `integration_status` passam a considerar ciphertext OU plaintext, continuam sem projetar valor de token

Não criptografa em SQL. Não remove nenhuma coluna plaintext. Rollback remove só as estruturas novas.

## 6. Script de migração

`node scripts/migrate-token-encryption.js --env=<nome> [--apply] [--batch=N]`

- dry-run por padrão; `--apply` para escrever; `--env=` obrigatório (confirmação).
- recusa qualquer `DB_URL` que não seja `127.0.0.1`/`localhost` nesta fase.
- advisory lock impede execução concorrente; processa em lotes com cursor (retomável).
- só grava `*_encrypted` onde está nulo; só marca `token_encryption_migrated_at` após
  `encrypt → decrypt → compare`; nunca imprime token/plaintext/ciphertext/chave (só contagens e IDs `xxxxxxxx…`).
- exit ≠ 0 se houver qualquer falha. Relatório: total, migrado, já, inválido, falho.

## 7. Frontend (auditoria read-only — nada alterado)

- `session.access_token` em `App.jsx`/`Login.jsx`/`SetPassword.jsx` é o **JWT do Supabase Auth**,
  não uma coluna deste inventário.
- `client.js` fala só com a API Express; `getIntegrations` chama `/integrations` (payload sem token).
- `updateWhatsappIntegration` envia o `access_token` que o médico digitou para `PATCH /integrations/whatsapp` — contrato inalterado; agora o backend cifra na persistência.
- **Gap pré-existente (FASE 2.1, fora do escopo aqui):** `Integrations.jsx` monta a URL de webhook
  de pagamento com `integ.webhook_token`, que a API já não devolve desde o 0008. A tela de
  configuração de gateway de pagamento precisa de um endpoint dedicado que gere/mostre a URL
  sem expor o token — item para uma fase futura de UX de integrações.
