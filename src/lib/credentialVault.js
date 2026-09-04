// FASE 2.2 — Camada ÚNICA de credenciais em repouso.
//
// Nenhum outro módulo deve tocar diretamente nas colunas de token/segredo:
//   integrations.access_token / webhook_token
//   google_tokens.access_token / refresh_token
//
// Primitivas: só `node:crypto` nativo.
//   - AES-256-GCM, IV aleatório de 12 bytes por operação, tag de 16 bytes.
//   - AAD obrigatória amarrando o ciphertext a tabela/registro/campo/tenant/provider.
//   - Envelope versionado E versão de chave — campos SEPARADOS, nunca confundidos.
//   - Falha fechada: ciphertext/tag/AAD/versão inválidos LANÇAM, nunca caem para plaintext.
//   - Blind index HMAC-SHA256 com chave dedicada para localizar webhook_token
//     sem descriptografar todas as linhas.
//
// Formato do envelope (string única):
//   e1.<keyVersion>.<iv_b64url>.<ciphertext_b64url>.<tag_b64url>
//   - "e1"        -> versão do ENVELOPE (formato/algoritmo)
//   - "<keyVersion>" -> versão da CHAVE no keyring, ex.: "v2"

import crypto from 'node:crypto';
import { env, parseKeyring } from '../config/env.js';
import { supabase } from './supabase.js';

const ENVELOPE_VERSION = 'e1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

// ---------------------------------------------------------------------------
// Estado de configuração (lazy — só materializa chaves quando a cripto é usada)
// ---------------------------------------------------------------------------
let _state = null;

export function loadCryptoState(source = env) {
  const enabled = source.TOKEN_ENCRYPTION_ENABLED === 'true';
  const dualWrite = source.TOKEN_ENCRYPTION_DUAL_WRITE === 'true';
  const allowPlaintextRead = source.TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ === 'true';

  if (!enabled) {
    return { enabled: false, dualWrite: false, allowPlaintextRead, keyring: null, activeKey: null, hmacKey: null };
  }
  const keyring = parseKeyring(source.TOKEN_ENCRYPTION_KEYRING);
  const activeKey = source.TOKEN_ENCRYPTION_ACTIVE_KEY;
  if (!activeKey || !keyring.has(activeKey)) {
    throw new Error('CredentialVault: TOKEN_ENCRYPTION_ACTIVE_KEY inválida para o keyring');
  }
  const hmacKey = Buffer.from(
    String(source.TOKEN_LOOKUP_HMAC_KEY).replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  );
  if (hmacKey.length < KEY_BYTES) {
    throw new Error('CredentialVault: TOKEN_LOOKUP_HMAC_KEY com menos de 32 bytes');
  }
  return { enabled: true, dualWrite, allowPlaintextRead, keyring, activeKey, hmacKey };
}

function state() {
  if (!_state) _state = loadCryptoState();
  return _state;
}

// Para testes: recarrega o estado a partir de um source fake.
export function __setCryptoStateForTests(source) {
  _state = source ? loadCryptoState(source) : null;
}

// ---------------------------------------------------------------------------
// AAD canonica -- ordem fixa, com separador de controle US (0x1F) que nao
// aparece em nome de tabela/campo, UUID, gateway nem prefixo de escopo. Isso
// garante enquadramento nao-ambiguo: nenhum par de tuplas distintas produz a
// mesma AAD -> ciphertext nao migra entre campo/registro/tenant/provider.
// ---------------------------------------------------------------------------
const AAD_SEP = String.fromCharCode(0x1f);

export function buildAad({ table, recordId, field, scope, provider }) {
  for (const [k, v] of Object.entries({ table, recordId, field, scope })) {
    if (v == null || String(v) === '') throw new Error(`AAD incompleta: "${k}" ausente`);
  }
  const parts = ['pgx', 'v1', table, String(recordId), field, String(scope), provider || 'none'];
  if (parts.some((x) => x.includes(AAD_SEP))) throw new Error('AAD: componente contem separador reservado');
  return Buffer.from(parts.join(AAD_SEP), 'utf8');
}
// ---------------------------------------------------------------------------
// TokenCipher
// ---------------------------------------------------------------------------
export const TokenCipher = {
  encrypt(plaintext, aad) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new Error('TokenCipher.encrypt: plaintext vazio');
    }
    if (!Buffer.isBuffer(aad) || aad.length === 0) throw new Error('TokenCipher.encrypt: AAD obrigatória');
    const { keyring, activeKey } = state();
    const key = keyring.get(activeKey);
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENVELOPE_VERSION}.${activeKey}.${b64url(iv)}.${b64url(ct)}.${b64url(tag)}`;
  },

  // Falha FECHADA: qualquer inconsistência lança. Nunca retorna plaintext parcial.
  decrypt(envelope, aad) {
    if (typeof envelope !== 'string') throw new Error('TokenCipher.decrypt: envelope ausente');
    const parts = envelope.split('.');
    if (parts.length !== 5) throw new Error('TokenCipher.decrypt: envelope malformado');
    const [ev, keyVersion, ivStr, ctStr, tagStr] = parts;
    if (ev !== ENVELOPE_VERSION) throw new Error(`TokenCipher.decrypt: versão de envelope desconhecida "${ev}"`);
    if (!/^v\d+$/.test(keyVersion)) throw new Error('TokenCipher.decrypt: versão de chave malformada');
    if (!Buffer.isBuffer(aad) || aad.length === 0) throw new Error('TokenCipher.decrypt: AAD obrigatória');
    const { keyring } = state();
    const key = keyring.get(keyVersion);
    if (!key) throw new Error(`TokenCipher.decrypt: chave "${keyVersion}" ausente no keyring`);
    const iv = fromB64url(ivStr);
    const ct = fromB64url(ctStr);
    const tag = fromB64url(tagStr);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error('TokenCipher.decrypt: IV/tag com tamanho inválido');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    // .final() lança se a tag não bater (ciphertext/AAD adulterados).
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  },

  envelopeKeyVersion(envelope) {
    if (typeof envelope !== 'string') return null;
    const parts = envelope.split('.');
    return parts.length === 5 && parts[0] === ENVELOPE_VERSION ? parts[1] : null;
  },

  isEnvelope(value) {
    return typeof value === 'string' && value.startsWith(`${ENVELOPE_VERSION}.`) && value.split('.').length === 5;
  },
};

// ---------------------------------------------------------------------------
// TokenLookup — blind index keyed (HMAC-SHA256)
// ---------------------------------------------------------------------------
export const TokenLookup = {
  // Normalização mínima e explícita: apara espaços nas pontas. Nada mais.
  normalize(token) {
    return String(token ?? '').trim();
  },

  blindIndex(token) {
    const norm = this.normalize(token);
    if (norm === '') throw new Error('TokenLookup.blindIndex: token vazio');
    const { hmacKey } = state();
    return crypto.createHmac('sha256', hmacKey).update(norm, 'utf8').digest('base64url');
  },

  // Comparação em tempo constante entre dois tokens já conhecidos.
  safeEquals(a, b) {
    const ba = Buffer.from(String(a ?? ''), 'utf8');
    const bb = Buffer.from(String(b ?? ''), 'utf8');
    if (ba.length !== bb.length) {
      // timingSafeEqual exige mesmo tamanho — compara contra si mesmo p/ custo constante.
      crypto.timingSafeEqual(ba, ba);
      return false;
    }
    return crypto.timingSafeEqual(ba, bb);
  },
};

// ---------------------------------------------------------------------------
// Helpers de leitura/escrita por campo
// ---------------------------------------------------------------------------
function decryptFieldOrFail(row, field, aadParts) {
  const enc = row[`${field}_encrypted`];
  const plain = row[field];
  const st = state();

  if (enc != null && enc !== '') {
    // Ciphertext presente -> obrigatoriamente válido. Falha fechada.
    return TokenCipher.decrypt(enc, buildAad({ ...aadParts, field }));
  }
  if (!st.enabled) return plain ?? null; // modo legado puro
  if (st.allowPlaintextRead) return plain ?? null; // janela de migração
  if (plain != null && plain !== '') {
    throw new Error(`CredentialVault: campo "${field}" só existe em plaintext e a leitura de plaintext está desabilitada`);
  }
  return null;
}

function encryptFieldForWrite(value, field, aadParts) {
  const envelope = TokenCipher.encrypt(value, buildAad({ ...aadParts, field }));
  // Verificação imediata: o ciphertext descriptografa para o valor original.
  const roundtrip = TokenCipher.decrypt(envelope, buildAad({ ...aadParts, field }));
  if (!TokenLookup.safeEquals(roundtrip, value)) {
    throw new Error(`CredentialVault: verificação de round-trip falhou para "${field}"`);
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// CredentialVault — API pública
// ---------------------------------------------------------------------------
export const CredentialVault = {
  isEnabled() {
    return state().enabled;
  },
  isDualWrite() {
    return state().dualWrite;
  },

  // --- integrations ---------------------------------------------------------
  // row precisa conter: id, doctor_id, gateway, access_token, webhook_token,
  //                     access_token_encrypted, webhook_token_encrypted
  // fields limita quais colunas são descriptografadas — assim a corrupção de
  // um campo não bloqueia o uso de outro (ex.: webhook_token inválido não deve
  // impedir o envio de WhatsApp que só precisa do access_token).
  readIntegrationCredentialsFromRow(row, fields = ['access_token', 'webhook_token']) {
    if (!row) return { access_token: null, webhook_token: null };
    const aadParts = { table: 'integrations', recordId: row.id, scope: `doctor:${row.doctor_id}`, provider: row.gateway };
    const out = { access_token: null, webhook_token: null };
    for (const f of fields) out[f] = decryptFieldOrFail(row, f, aadParts);
    return out;
  },

  async readIntegrationCredentials({ doctorId, gateway }) {
    const { data, error } = await supabase
      .from('integrations')
      .select('id, doctor_id, gateway, external_id, access_token, webhook_token, access_token_encrypted, webhook_token_encrypted')
      .eq('doctor_id', doctorId)
      .eq('gateway', gateway)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data.id,
      external_id: data.external_id,
      ...this.readIntegrationCredentialsFromRow(data, ['access_token']),
    };
  },

  // Monta o patch de atualização para as colunas de credencial de uma integration.
  // NUNCA retorna os valores. Depende de já conhecer id + doctor_id + gateway.
  buildIntegrationCredentialPatch({ id, doctorId, gateway, values }) {
    const st = state();
    const patch = {};
    const aadParts = { table: 'integrations', recordId: id, scope: `doctor:${doctorId}`, provider: gateway };

    for (const [field, value] of Object.entries(values)) {
      if (value == null) continue;
      if (!['access_token', 'webhook_token'].includes(field)) {
        throw new Error(`buildIntegrationCredentialPatch: campo não suportado "${field}"`);
      }
      if (!st.enabled) {
        patch[field] = value; // modo legado: só plaintext, patch idêntico ao antigo
        continue;
      }
      patch[`${field}_encrypted`] = encryptFieldForWrite(value, field, aadParts);
      if (field === 'webhook_token') patch.webhook_token_lookup = TokenLookup.blindIndex(value);
      if (st.dualWrite) patch[field] = value; // janela de migração
      // fora do dual-write: NÃO grava plaintext, mas TAMBÉM não apaga (fase futura).
    }
    if (st.enabled) patch.token_encryption_migrated_at = new Date().toISOString();
    return patch;
  },

  // FASE 2.4 — gera um webhook_token novo e devolve o VALOR CLARO **uma única
  // vez** para o chamador, junto com o patch de persistência (já cifrado/indexado
  // conforme as flags) e o fingerprint não-reversível para a UI.
  // O token anterior deixa de resolver assim que o patch é gravado.
  buildWebhookTokenRotation({ id, doctorId, gateway }) {
    const token = crypto.randomBytes(32).toString('base64url'); // >=256 bits
    const fingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
    const patch = {
      ...this.buildIntegrationCredentialPatch({ id, doctorId, gateway, values: { webhook_token: token } }),
      webhook_token_rotated_at: new Date().toISOString(),
      webhook_token_fingerprint: fingerprint,
    };
    return { token, fingerprint, patch };
  },

  async writeIntegrationCredentials({ id, doctorId, gateway, values }) {
    const patch = this.buildIntegrationCredentialPatch({ id, doctorId, gateway, values });
    const { error } = await supabase.from('integrations').update(patch).eq('id', id);
    if (error) throw error;
  },

  // Resolve o doctor_id a partir do webhook_token, via blind index quando a
  // cripto está ligada, ou por igualdade direta no modo legado.
  async resolveIntegrationByWebhookToken({ gateway, token }) {
    const norm = TokenLookup.normalize(token);
    if (norm === '') return null;
    const st = state();

    if (!st.enabled) {
      const { data, error } = await supabase
        .from('integrations')
        .select('id, doctor_id')
        .eq('gateway', gateway)
        .eq('webhook_token', norm)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, doctor_id: data.doctor_id } : null;
    }

    const digest = TokenLookup.blindIndex(norm);
    const { data: candidates, error } = await supabase
      .from('integrations')
      .select('id, doctor_id, gateway, access_token, webhook_token, access_token_encrypted, webhook_token_encrypted')
      .eq('gateway', gateway)
      .eq('webhook_token_lookup', digest);
    if (error) throw error;

    // Colisão de digest é improvável mas tratada: confirma o token real de cada
    // candidato com comparação timing-safe antes de aceitar.
    for (const row of candidates || []) {
      let real;
      try {
        real = this.readIntegrationCredentialsFromRow(row, ['webhook_token']).webhook_token;
      } catch {
        continue; // ciphertext inválido -> ignora candidato, não vaza
      }
      if (real && TokenLookup.safeEquals(real, norm)) {
        return { id: row.id, doctor_id: row.doctor_id };
      }
    }

    // Fallback de migração: linha ainda sem lookup, só plaintext.
    if (st.allowPlaintextRead) {
      const { data, error: e2 } = await supabase
        .from('integrations')
        .select('id, doctor_id')
        .eq('gateway', gateway)
        .eq('webhook_token', norm)
        .maybeSingle();
      if (e2) throw e2;
      return data ? { id: data.id, doctor_id: data.doctor_id } : null;
    }
    return null;
  },

  // --- google_tokens ------------------------------------------------------
  readGoogleTokensFromRow(row) {
    if (!row) return { access_token: null, refresh_token: null };
    const aadParts = { table: 'google_tokens', recordId: row.user_id, scope: `user:${row.user_id}`, provider: 'google' };
    return {
      access_token: decryptFieldOrFail(row, 'access_token', aadParts),
      refresh_token: decryptFieldOrFail(row, 'refresh_token', aadParts),
    };
  },

  async readGoogleTokens({ userId }) {
    const { data, error } = await supabase
      .from('google_tokens')
      .select('user_id, calendar_id, expiry, access_token, refresh_token, access_token_encrypted, refresh_token_encrypted')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      user_id: data.user_id,
      calendar_id: data.calendar_id,
      expiry: data.expiry,
      ...this.readGoogleTokensFromRow(data),
    };
  },

  buildGoogleTokenPatch({ userId, values }) {
    const st = state();
    const patch = {};
    const aadParts = { table: 'google_tokens', recordId: userId, scope: `user:${userId}`, provider: 'google' };
    for (const [field, value] of Object.entries(values)) {
      if (value == null) continue;
      if (!['access_token', 'refresh_token'].includes(field)) {
        throw new Error(`buildGoogleTokenPatch: campo não suportado "${field}"`);
      }
      if (!st.enabled) {
        patch[field] = value;
        continue;
      }
      patch[`${field}_encrypted`] = encryptFieldForWrite(value, field, aadParts);
      if (st.dualWrite) patch[field] = value;
    }
    if (st.enabled) patch.token_encryption_migrated_at = new Date().toISOString();
    return patch;
  },

  async writeGoogleTokens({ userId, values, extra = {} }) {
    const patch = { user_id: userId, ...extra, ...this.buildGoogleTokenPatch({ userId, values }) };
    const { error } = await supabase.from('google_tokens').upsert(patch);
    if (error) throw error;
  },

  // --- rotação -----------------------------------------------------------
  needsRotation(envelope) {
    const st = state();
    if (!st.enabled) return false;
    const v = TokenCipher.envelopeKeyVersion(envelope);
    return v != null && v !== st.activeKey;
  },
};
