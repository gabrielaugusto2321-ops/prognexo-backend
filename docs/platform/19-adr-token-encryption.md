# ADR 19 — Criptografia de tokens de integração em repouso (AR-3)

- **Status:** proposto (implementação na FASE 2.2)
- **Data:** 2026-09-03
- **Contexto de origem:** FASE 2.1 / ETAPA 7. Nesta subfase foi feita apenas **contenção**;
  este ADR define o desenho definitivo.

## 1. Contexto

As tabelas `public.integrations` e `public.google_tokens` guardam segredos de longa
duração em texto puro:

| Tabela | Colunas sensíveis |
| --- | --- |
| `integrations` | `access_token`, `refresh_token`, `webhook_token` |
| `google_tokens` | `access_token`, `refresh_token` |

Riscos:

- Qualquer vazamento de dump do banco (backup, réplica, log de query, screenshot de
  suporte) expõe credenciais que dão controle total do WhatsApp Cloud API e do Google
  Calendar do cliente.
- Antes da FASE 2.1 o `anon`/`authenticated` do PostgREST tinha `SELECT` nessas tabelas
  — o navegador conseguia ler os tokens.

### Contenção já aplicada na FASE 2.1 (migration 0008)

- `revoke select on public.integrations, public.google_tokens from anon, authenticated`.
- Views seguras que **nunca** projetam colunas de token:
  - `public.google_connection_status` → `connected`, `expires_at`, `has_calendar`.
  - `public.integration_status` → `has_access_token` (boolean), `has_webhook_token` (boolean),
    escopada por `is_doctor_owner` / `is_org_member` / `is_platform_admin`.
- O frontend já não depende das colunas de token (audit em `18-tenancy-compat-audit.md`):
  usa `/auth/google/status` e `/integrations` (a rota Express remove os tokens do payload).
- Os tokens continuam em texto puro **no banco**; só o backend (service-role) os lê.
  A criptografia em repouso é o que falta e é o escopo deste ADR.

## 2. Decisão

Cifrar as colunas de token em repouso com **AES-256-GCM**, com a chave **fora do banco**,
usando **envelope encryption** e **versionamento de chave**, com rotação sem downtime.

### 2.1 Algoritmo e formato

- **AEAD:** AES-256-GCM (IV de 96 bits aleatório por operação, tag de 128 bits).
- **AAD:** identificador lógico do registro (`"integrations:{id}:access_token"`), para
  impedir troca de ciphertext entre linhas/colunas.
- **Formato armazenado** (string única, base64url, prefixada por versão):

  ```
  v{key_version}.{iv}.{ciphertext}.{tag}
  ```

  Ex.: `v2.7mN0...==.9jQ2...==.Ab12...==`. O prefixo `v{n}` permite decifrar registros
  cifrados com chaves antigas durante a rotação.

### 2.2 Hierarquia de chaves (envelope)

```
KEK (Key Encryption Key)  ──► fora do banco, no gerenciador de segredos do ambiente
      │                        (staging/prod: KMS/Secret Manager; dev/test: env var)
      ▼
DEK (Data Encryption Key) ──► cifra as colunas; guardada cifrada pela KEK em
                              public.crypto_keys (id, version, dek_wrapped, status,
                              created_at, rotated_at)
```

- Fase inicial (2.2): **uma DEK ativa por vez**, KEK vinda de `TOKEN_ENCRYPTION_KEK`
  (32 bytes base64) validada no `env.js` (zod) e **nunca logada**.
- Evolução (pós-2.2): KEK em AWS KMS / GCP KMS / Supabase Vault; `dek_wrapped` passa a
  ser o resultado de `kms:Encrypt`. O formato do ciphertext não muda.

### 2.3 Versionamento e rotação

- `crypto_keys.version` inteiro crescente; `status ∈ {active, retiring, retired}`.
- Rotação:
  1. Gera DEK nova, `status=active`; a anterior vira `retiring`.
  2. Escritas novas usam sempre a `active` (novo prefixo `v{n}`).
  3. Job de re-cifragem em lote (idempotente, `where key_version < active`) reescreve os
     registros `retiring` → `active`, com paginação e rate-limit.
  4. Quando não sobra nenhum registro na versão antiga, ela vira `retired` (a DEK
     wrapped pode ser destruída após período de retenção).
- Rotação de KEK: re-wrap das DEKs (`kms:Decrypt` + `kms:Encrypt`), sem tocar nas colunas.

### 2.4 Camada de acesso

- Módulo único `src/lib/tokenCrypto.js`: `encryptToken(plaintext, aadParts)` /
  `decryptToken(stored, aadParts)`. Nenhum outro lugar do código manipula IV/tag.
- Todo acesso a token passa por um repositório (`integrationsRepo`, `googleTokensRepo`)
  que decifra na leitura e cifra na escrita. As rotas/serviços recebem o valor já claro
  e **apenas em memória**.
- `decryptToken` nunca joga o plaintext em exceção/stack; erros são `TokenDecryptError`
  com `{ id, key_version }`, sem material.

## 3. Migração segura dos tokens existentes

Migração **aditiva e reversível**, sem downtime:

1. **Migration estrutural:** adiciona colunas `*_enc text` ao lado das colunas atuais;
   cria `crypto_keys`; NÃO remove nada.
2. **Backfill** (script Node, service-role, idempotente, em lotes):
   - para cada linha com `access_token is not null and access_token_enc is null`:
     `access_token_enc = encryptToken(access_token, aad)`.
   - registra progresso em tabela de controle; pode ser re-executado.
3. **Dual-read / dual-write** (1 release):
   - escrita: grava `*_enc` (fonte da verdade) e mantém `*` preenchido só para rollback.
   - leitura: usa `*_enc`; se nulo (linha nova de release anterior), cai para `*`.
4. **Cutover:** quando `count(* where *_enc is null and * is not null) = 0`, a leitura
   passa a exigir `*_enc`.
5. **Limpeza** (release seguinte, migration própria): `update ... set access_token = null`
   (ou `drop column` após janela de segurança). Ponto sem volta — documentado no runbook.
6. **RLS/grants:** as colunas `*_enc` herdam o `revoke select from anon, authenticated`
   já aplicado em 0008; as views seguras continuam derivando só `has_*_token`.

## 4. Zero exposição em logs

- `env.js`: KEK e afins marcados como segredo; o logger já tem redaction — adicionar
  `token`, `access_token`, `refresh_token`, `webhook_token`, `dek_wrapped`, `kek` à lista.
- Proibir `console.log` de objetos de integração; lint de segurança
  (`scripts/check-security-patterns.js`) ganha padrão que barra `log.*token` com valor.
- Erros de decrypt logam só `id` + `key_version`.
- Testes: um teste garante que a resposta de `/integrations` e `/auth/google/status`
  não contém nenhuma das colunas de token nem o formato `v{n}.`.

## 5. Recuperação e rollback

| Cenário | Ação |
| --- | --- |
| Bug na camada de cripto pós-deploy, antes da limpeza (passo 5) | `TOKEN_ENCRYPTION_READ_PLAINTEXT_FALLBACK=true` volta a leitura para a coluna `*` (ainda preenchida). Reverter o release. |
| KEK perdida | Tokens irrecuperáveis por design. Mitigação: KEK em KMS com política de backup + versionamento; cada cliente pode **reconectar** WhatsApp/Google (fluxo OAuth/Embedded Signup) — os tokens são regeneráveis. Runbook de "reconexão em massa". |
| DEK corrompida | Decifrar com a `retiring` anterior (ainda em `crypto_keys`) e re-cifrar. |
| Rollback total da FASE 2.2 | Migration de rollback: remove colunas `*_enc` e `crypto_keys`; as colunas `*` seguem sendo a fonte da verdade (nunca foram apagadas até o passo 5). |

## 6. Consequências

- **Positivas:** dump de banco deixa de vazar credenciais; base para conformidade;
  rotação vira operação de rotina; navegador nunca mais toca em token (já garantido em 0008).
- **Custos:** +1 hop de cripto por acesso a token; gestão de KEK/KMS no provisionamento
  de cada ambiente; runbook de rotação e de reconexão em massa.
- **Não-objetivos desta linha:** cifrar o banco inteiro (é responsabilidade do provedor),
  HSM dedicado, criptografia client-side.

## 7. Pendências para a FASE 2.2

- [ ] `src/lib/tokenCrypto.js` + testes (vetores conhecidos, AAD, versão).
- [ ] `crypto_keys` + migration aditiva das colunas `*_enc`.
- [ ] Repositórios `integrationsRepo` / `googleTokensRepo` com dual-read/dual-write.
- [ ] Script de backfill idempotente em lotes.
- [ ] Job de re-cifragem para rotação.
- [ ] Redaction de logs + padrão no lint de segurança.
- [ ] Runbook: rotação de DEK, rotação de KEK, reconexão em massa.
- [ ] Decisão de provedor de KMS por ambiente (staging/prod).
