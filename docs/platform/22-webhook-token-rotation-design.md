# FASE 2.3 — `webhook_token`: gap atual e desenho de rotação (SÓ DESENHO)

Nenhuma implementação nesta fase (Decisão 4 do proprietário). Este documento
cumpre a ETAPA 7: documentar o gap, confirmar provedores, mapear o impacto de
rotação e propor um contrato seguro de criação/rotação.

## 1. O gap atual

- `integrations.webhook_token` é gerado pelo banco no `INSERT` da linha
  (`default encode(extensions.gen_random_bytes(16), 'hex')` — baseline).
- O provedor de pagamento é configurado com uma URL que embute esse token
  (`.../webhooks/<gateway>` + header `X-Prognexo-Webhook-Token: <token>` — hoje o
  frontend montava `?secret=<token>` na URL, caminho legado marcado como
  deprecado em `paymentFactory.js`).
- Desde a **FASE 2.1 (migration 0008)** o `SELECT` do browser em `integrations`
  foi revogado; desde a **FASE 2.2 (migration 0009)** a coluna é cifrada em
  repouso e `GET /integrations` devolve apenas `webhook_token_configurado`
  (boolean) via `stripSecrets`.
- **Consequência:** `src/pages/Integrations.jsx` monta `buildUrl(gateway, integ.webhook_token)`
  com um valor que a API **não devolve mais** → a tela de configuração de
  gateway de pagamento não consegue exibir a URL para o médico copiar.

**A FASE 2.3 NÃO reintroduz `webhook_token` em nenhuma resposta.** O gap
permanece aberto; a solução é o contrato abaixo, para uma fase própria.

## 2. Provedores que usam `webhook_token`

Confirmado em `src/webhooks/paymentFactory.js` + `src/webhooks/{pagarme,kiwify,hotmart,ticto}.js`
e `src/lib/salesWebhook.js:resolveDoctorFromToken`:

| provedor | usa `webhook_token` p/ rotear tenant? | verificação adicional |
|---|---|---|
| **Pagar.me** | sim (header `X-Prognexo-Webhook-Token` ou `?secret=`) | HMAC-SHA1 do corpo (`PAGARME_WEBHOOK_SECRET`) |
| **Kiwify** | sim | HMAC-SHA1 do corpo (`KIWIFY_WEBHOOK_SECRET`) |
| **Hotmart** | sim | token estático `hottok` comparado em tempo constante (`HOTMART_HOTTOK`) |
| **Ticto** | sim | sem assinatura criptográfica — gate `TICTO_WEBHOOK_ENABLED` + `TICTO_TOKEN` |
| WhatsApp Cloud API | **não** — roteia por `phone_number_id → integrations.external_id` | assinatura `META_APP_SECRET` (Meta, congelado) |

Ou seja: **4 provedores de pagamento** dependem do `webhook_token`. O WhatsApp
**não** — e portanto **rotação de `webhook_token` não toca a integração Meta**.

## 3. Impacto de uma rotação

Trocar o `webhook_token` de uma integração:

1. **invalida a URL/segredo já cadastrado** no painel do provedor de pagamento —
   webhooks recebidos com o token antigo passam a resolver `doctor_id = null` →
   `paymentFactory` responde **401** e o evento **não é processado**.
2. exige que o médico **reconfigure** a URL no painel de cada gateway ativo.
3. o `webhook_token_lookup` (blind index HMAC, FASE 2.2) precisa ser
   **recalculado** junto — já é, se a escrita passar pelo `CredentialVault`.
4. eventos "em voo" durante a janela de troca podem ser perdidos → a rotação
   deve ser **explícita e comunicada**, nunca automática/silenciosa.
5. trocar `TOKEN_LOOKUP_HMAC_KEY` (global) invalida **todos** os lookups de uma
   vez — é uma operação separada, de manutenção, não uma rotação por tenant.

## 4. Contrato seguro proposto (implementação = fase futura)

### 4.1 Princípios

- o segredo completo é retornado **uma única vez**, no instante da criação/rotação;
- **nunca** é possível consultar o segredo completo depois (`GET /integrations`
  continua devolvendo só `webhook_token_configurado` + um **prefixo** de 6 chars
  para identificação visual, ex. `whsec_ab12…`);
- rotação exige **confirmação humana explícita** (o médico clica "girar segredo"
  ciente de que precisará reconfigurar o gateway);
- toda criação/rotação é **auditada** (quem, quando, qual integração, qual
  gateway) numa tabela `webhook_token_events` (ou no log de auditoria existente);
- o valor persistido continua **cifrado** (`CredentialVault`, AES-256-GCM) e
  **indexado por blind index** (HMAC-SHA256) para o lookup no webhook.

### 4.2 Endpoints

```
POST /integrations/:gateway/webhook-token/rotate
  auth: requireAuth + attachTenantContext (tenant core define o doctor/org)
  body: { confirm: true }            # confirmação humana obrigatória
  ação:
    - gera 32 bytes aleatórios -> token = "whsec_" + base64url(bytes)
    - CredentialVault.buildIntegrationCredentialPatch({ values: { webhook_token } })
      (grava *_encrypted + *_lookup; plaintext só se DUAL_WRITE)
    - registra evento de auditoria
  resposta (ÚNICA vez):
    {
      "webhook_token": "whsec_....",          # só aqui, nunca mais
      "webhook_url": "https://api.../webhooks/<gateway>",
      "header": "X-Prognexo-Webhook-Token",
      "rotated_at": "..."
    }

GET /integrations   (inalterado no que diz respeito a segredo)
  -> por integração: { ..., webhook_token_configurado: true,
                       webhook_token_prefix: "whsec_ab12" }   # 6..10 chars, não o segredo
```

### 4.3 Migração dos tokens legados

- tokens atuais (`gen_random_bytes(16)` hex) continuam válidos até o médico girar;
- na primeira listagem pós-deploy, a UI mostra um aviso "gire o segredo do
  webhook para poder copiar a URL de novo" nas integrações de pagamento;
- opcional: um comando de manutenção que força rotação em lote (com o mesmo
  fluxo de auditoria), comunicado com antecedência.

### 4.4 Fora do escopo / cuidados

- **Não** tocar no webhook do WhatsApp (Meta congelada) — ele nem usa `webhook_token`.
- **Não** reexpor `webhook_token` em nenhuma rota de leitura.
- A implementação depende de confirmar, com cada provedor de pagamento, se a URL
  aceita o token em **header** (preferido) e como o painel deles trata a troca.

## 5. Recomendação

Abrir uma fase própria **"FASE 2.4 — rotação de segredos de webhook"** com:
(a) implementação do contrato acima; (b) tela de rotação no frontend com
confirmação; (c) tabela/eventos de auditoria; (d) migração/aviso para os tokens
legados; (e) testes (criação retorna uma vez, GET nunca retorna, lookup resolve,
rotação invalida o token anterior, auditoria registrada).
