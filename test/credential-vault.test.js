import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../src/lib/supabase.js', () => ({ supabase: {} }));
import {
  TokenCipher,
  TokenLookup,
  CredentialVault,
  buildAad,
  loadCryptoState,
  __setCryptoStateForTests,
} from '../src/lib/credentialVault.js';
import { parseKeyring } from '../src/config/env.js';

// Chaves FALSAS, geradas dentro do teste. Nunca chaves reais.
const KEY_V1 = crypto.randomBytes(32).toString('base64');
const KEY_V2 = crypto.randomBytes(32).toString('base64');
const HMAC_KEY = crypto.randomBytes(48).toString('base64');

function source(overrides = {}) {
  return {
    TOKEN_ENCRYPTION_ENABLED: 'true',
    TOKEN_ENCRYPTION_DUAL_WRITE: 'false',
    TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ: 'false',
    TOKEN_ENCRYPTION_KEYRING: JSON.stringify({ v1: KEY_V1, v2: KEY_V2 }),
    TOKEN_ENCRYPTION_ACTIVE_KEY: 'v2',
    TOKEN_LOOKUP_HMAC_KEY: HMAC_KEY,
    ...overrides,
  };
}

const AAD = { table: 'integrations', recordId: 'rec-1', field: 'access_token', scope: 'doctor:doc-1', provider: 'whatsapp' };

afterEach(() => __setCryptoStateForTests(null));

describe('parseKeyring', () => {
  it('aceita keyring válido', () => {
    const kr = parseKeyring(JSON.stringify({ v1: KEY_V1, v2: KEY_V2 }));
    expect(kr.get('v1')).toHaveLength(32);
  });
  it('rejeita JSON inválido', () => expect(() => parseKeyring('{nope')).toThrow(/JSON/));
  it('rejeita objeto vazio', () => expect(() => parseKeyring('{}')).toThrow(/vazio/));
  it('rejeita rótulo fora de vN', () => expect(() => parseKeyring(JSON.stringify({ chave: KEY_V1 }))).toThrow(/rótulo/i));
  it('rejeita chave curta', () =>
    expect(() => parseKeyring(JSON.stringify({ v1: Buffer.alloc(16).toString('base64') }))).toThrow(/32 bytes/));
  it('rejeita versão duplicada', () =>
    expect(() => parseKeyring(`{"v1":"${KEY_V1}","v1":"${KEY_V2}"}`)).toThrow(/duplicada/));
});

describe('TokenCipher', () => {
  beforeEach(() => __setCryptoStateForTests(source()));

  it('round-trip', () => {
    const env = TokenCipher.encrypt('segredo-abc', buildAad(AAD));
    expect(env.startsWith('e1.v2.')).toBe(true);
    expect(TokenCipher.decrypt(env, buildAad(AAD))).toBe('segredo-abc');
  });

  it('IV aleatório: mesmo token -> envelopes diferentes', () => {
    const a = TokenCipher.encrypt('x', buildAad(AAD));
    const b = TokenCipher.encrypt('x', buildAad(AAD));
    expect(a).not.toBe(b);
    expect(TokenCipher.decrypt(a, buildAad(AAD))).toBe('x');
    expect(TokenCipher.decrypt(b, buildAad(AAD))).toBe('x');
  });

  it('ciphertext adulterado -> lança (falha fechada)', () => {
    const env = TokenCipher.encrypt('x', buildAad(AAD));
    const parts = env.split('.');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64url');
    expect(() => TokenCipher.decrypt(parts.join('.'), buildAad(AAD))).toThrow();
  });

  it('tag adulterada -> lança', () => {
    const env = TokenCipher.encrypt('x', buildAad(AAD));
    const parts = env.split('.');
    const tag = Buffer.from(parts[4], 'base64url');
    tag[0] ^= 0xff;
    parts[4] = tag.toString('base64url');
    expect(() => TokenCipher.decrypt(parts.join('.'), buildAad(AAD))).toThrow();
  });

  it('versão de envelope desconhecida -> lança', () => {
    const env = TokenCipher.encrypt('x', buildAad(AAD));
    expect(() => TokenCipher.decrypt(env.replace(/^e1\./, 'e9.'), buildAad(AAD))).toThrow(/envelope/i);
  });

  it('versão de chave inexistente -> lança', () => {
    const env = TokenCipher.encrypt('x', buildAad(AAD)).replace('.v2.', '.v7.');
    expect(() => TokenCipher.decrypt(env, buildAad(AAD))).toThrow(/keyring/i);
  });

  it('AAD errada -> lança', () => {
    const env = TokenCipher.encrypt('x', buildAad(AAD));
    expect(() => TokenCipher.decrypt(env, buildAad({ ...AAD, field: 'webhook_token' }))).toThrow();
  });

  it('AAD com enquadramento não-ambíguo: tuplas que colidiriam com join vazio não se cruzam', () => {
    // ('integrations','rec1',...) vs ('integration','srec1',...) concatenariam igual sem separador
    const e = TokenCipher.encrypt('x', buildAad({ table: 'integrations', recordId: 'rec1', field: 'access_token', scope: 'doctor:d', provider: 'p' }));
    expect(() =>
      TokenCipher.decrypt(e, buildAad({ table: 'integration', recordId: 'srec1', field: 'access_token', scope: 'doctor:d', provider: 'p' }))
    ).toThrow();
  });

  it('AAD: componente contendo o separador reservado é rejeitado', () => {
    expect(() => buildAad({ table: 'integrations', recordId: 'r\x1fx', field: 'access_token', scope: 's', provider: 'p' })).toThrow(/separador/i);
  });

  it('swap de ciphertext entre tenants/campos falha', () => {
    const forDoc1 = TokenCipher.encrypt('token-doc1', buildAad({ ...AAD, recordId: 'rec-1', scope: 'doctor:doc-1' }));
    // tentar decifrar como se fosse de outro registro/tenant
    expect(() =>
      TokenCipher.decrypt(forDoc1, buildAad({ ...AAD, recordId: 'rec-2', scope: 'doctor:doc-2' }))
    ).toThrow();
  });

  it('rotação v1 -> v2: decifra o antigo, needsRotation aponta reencrypt', () => {
    __setCryptoStateForTests(source({ TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1' }));
    const oldEnv = TokenCipher.encrypt('legacy', buildAad(AAD));
    __setCryptoStateForTests(source({ TOKEN_ENCRYPTION_ACTIVE_KEY: 'v2' }));
    expect(TokenCipher.decrypt(oldEnv, buildAad(AAD))).toBe('legacy'); // v1 ainda no keyring
    expect(CredentialVault.needsRotation(oldEnv)).toBe(true);
    const newEnv = TokenCipher.encrypt('legacy', buildAad(AAD));
    expect(CredentialVault.needsRotation(newEnv)).toBe(false);
  });

  it('config inválida (active key fora do keyring) -> loadCryptoState lança', () => {
    expect(() => loadCryptoState(source({ TOKEN_ENCRYPTION_ACTIVE_KEY: 'v9' }))).toThrow();
  });
});

describe('TokenLookup (blind index)', () => {
  beforeEach(() => __setCryptoStateForTests(source()));

  it('mesmo token -> mesmo digest', () => {
    expect(TokenLookup.blindIndex('wht-abc')).toBe(TokenLookup.blindIndex(' wht-abc '));
  });
  it('tokens diferentes -> digests diferentes', () => {
    expect(TokenLookup.blindIndex('a')).not.toBe(TokenLookup.blindIndex('b'));
  });
  it('digest não é hash simples (depende da chave)', () => {
    const d1 = TokenLookup.blindIndex('same');
    __setCryptoStateForTests(source({ TOKEN_LOOKUP_HMAC_KEY: crypto.randomBytes(48).toString('base64') }));
    expect(TokenLookup.blindIndex('same')).not.toBe(d1);
  });
  it('safeEquals: igual / diferente / tamanhos distintos', () => {
    expect(TokenLookup.safeEquals('abc', 'abc')).toBe(true);
    expect(TokenLookup.safeEquals('abc', 'abd')).toBe(false);
    expect(TokenLookup.safeEquals('abc', 'abcd')).toBe(false);
  });
});

describe('CredentialVault — compatibilidade de leitura/escrita', () => {
  const rowBase = { id: 'i1', doctor_id: 'd1', gateway: 'whatsapp' };

  it('modo legado (ENABLED=false): patch grava só plaintext', () => {
    __setCryptoStateForTests(source({ TOKEN_ENCRYPTION_ENABLED: 'false', TOKEN_ENCRYPTION_DUAL_WRITE: 'false' }));
    const patch = CredentialVault.buildIntegrationCredentialPatch({
      id: 'i1', doctorId: 'd1', gateway: 'whatsapp', values: { access_token: 'plain' },
    });
    expect(patch).toEqual({ access_token: 'plain' });
  });

  it('encrypted-only: patch tem ciphertext, sem plaintext', () => {
    __setCryptoStateForTests(source({ TOKEN_ENCRYPTION_DUAL_WRITE: 'false' }));
    const patch = CredentialVault.buildIntegrationCredentialPatch({
      id: 'i1', doctorId: 'd1', gateway: 'whatsapp', values: { access_token: 'sekret', webhook_token: 'wht-1' },
    });
    expect(patch.access_token).toBeUndefined();
    expect(patch.webhook_token).toBeUndefined();
    expect(TokenCipher.isEnvelope(patch.access_token_encrypted)).toBe(true);
    expect(patch.webhook_token_lookup).toBe(TokenLookup.blindIndex('wht-1'));
    expect(patch.token_encryption_migrated_at).toBeTruthy();
  });

  it('dual-write: patch tem ciphertext E plaintext', () => {
    __setCryptoStateForTests(source({ TOKEN_ENCRYPTION_DUAL_WRITE: 'true' }));
    const patch = CredentialVault.buildIntegrationCredentialPatch({
      id: 'i1', doctorId: 'd1', gateway: 'whatsapp', values: { access_token: 'sekret' },
    });
    expect(patch.access_token).toBe('sekret');
    expect(TokenCipher.isEnvelope(patch.access_token_encrypted)).toBe(true);
  });

  it('leitura: encrypted presente é usado', () => {
    __setCryptoStateForTests(source());
    const enc = TokenCipher.encrypt('real', buildAad({ table: 'integrations', recordId: 'i1', field: 'access_token', scope: 'doctor:d1', provider: 'whatsapp' }));
    const row = { ...rowBase, access_token: null, access_token_encrypted: enc, webhook_token: null, webhook_token_encrypted: null };
    expect(CredentialVault.readIntegrationCredentialsFromRow(row).access_token).toBe('real');
  });

  it('leitura: encrypted INVÁLIDO nunca cai para plaintext — lança', () => {
    __setCryptoStateForTests(source({ TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ: 'true' }));
    const row = { ...rowBase, access_token: 'plain-fallback', access_token_encrypted: 'e1.v2.AAAA.BBBB.CCCC', webhook_token: null, webhook_token_encrypted: null };
    expect(() => CredentialVault.readIntegrationCredentialsFromRow(row)).toThrow();
  });

  it('leitura: só plaintext + ALLOW_PLAINTEXT_READ=false -> falha fechada', () => {
    __setCryptoStateForTests(source({ TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ: 'false' }));
    const row = { ...rowBase, access_token: 'plain', access_token_encrypted: null, webhook_token: null, webhook_token_encrypted: null };
    expect(() => CredentialVault.readIntegrationCredentialsFromRow(row)).toThrow(/plaintext/i);
  });

  it('leitura: só plaintext + ALLOW_PLAINTEXT_READ=true -> devolve plaintext', () => {
    __setCryptoStateForTests(source({ TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ: 'true' }));
    const row = { ...rowBase, access_token: 'plain', access_token_encrypted: null, webhook_token: null, webhook_token_encrypted: null };
    expect(CredentialVault.readIntegrationCredentialsFromRow(row).access_token).toBe('plain');
  });
});
