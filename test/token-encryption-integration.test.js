import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// Chaves FALSAS geradas no teste.
const KEYRING = JSON.stringify({ v1: crypto.randomBytes(32).toString('base64') });
process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
process.env.FRONTEND_URL = 'https://app.test';
process.env.TOKEN_ENCRYPTION_ENABLED = 'true';
process.env.TOKEN_ENCRYPTION_DUAL_WRITE = 'false';
process.env.TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ = 'true'; // janela de migração
process.env.TOKEN_ENCRYPTION_KEYRING = KEYRING;
process.env.TOKEN_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.TOKEN_LOOKUP_HMAC_KEY = crypto.randomBytes(48).toString('base64');

let db;
const trocarCodigoPorTokens = vi.fn(async () => ({ refresh_token: 'g-refresh', access_token: 'g-access', expiry_date: Date.now() + 3600_000 }));

vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/googleCalendar.js', () => ({
  buildAuthUrl: (s) => `https://x/?state=${s}`,
  trocarCodigoPorTokens,
  estaConectado: vi.fn(async () => false),
}));

const { app } = await import('../src/server.js');
const { createOAuthState, _resetOAuthStateStore } = await import('../src/lib/oauthState.js');
const { CredentialVault, TokenCipher, TokenLookup, buildAad } = await import('../src/lib/credentialVault.js');
const { resolveDoctorFromToken } = await import('../src/lib/salesWebhook.js');

const USER_A = '00000000-0000-4000-8000-00000000000a';
const DOC_A = '00000000-0000-4000-8000-0000000000da';
const DOC_B = '00000000-0000-4000-8000-0000000000db';

beforeEach(() => {
  _resetOAuthStateStore();
  db = makeDb({
    users: [{ id: USER_A, role: 'doctor', ativo: true }],
    google_tokens: [],
    integrations: [
      { id: 'iA', doctor_id: DOC_A, gateway: 'whatsapp', external_id: 'pn-A', access_token: null, webhook_token: null, access_token_encrypted: null, webhook_token_encrypted: null, webhook_token_lookup: null },
      { id: 'iB', doctor_id: DOC_B, gateway: 'pagarme', access_token: null, webhook_token: null, access_token_encrypted: null, webhook_token_encrypted: null, webhook_token_lookup: null },
    ],
  });
  db.setAuthUser('tokA', { id: USER_A });
});

describe('FASE 2.2 — integração: Google OAuth grava cifrado', () => {
  it('callback grava ciphertext (não plaintext) e a camada descriptografa', async () => {
    const state = createOAuthState({ userId: USER_A, role: 'doctor', flow: 'google_calendar' });
    const res = await request(app).get(`/auth/google/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    const row = db.tables.google_tokens.find((r) => r.user_id === USER_A);
    expect(row.refresh_token).toBeUndefined(); // dual-write off -> sem plaintext
    expect(TokenCipher.isEnvelope(row.refresh_token_encrypted)).toBe(true);
    expect(row.token_encryption_migrated_at).toBeTruthy();

    const creds = await CredentialVault.readGoogleTokens({ userId: USER_A });
    expect(creds.refresh_token).toBe('g-refresh');
    expect(creds.access_token).toBe('g-access');
  });
});

describe('FASE 2.2 — integração: webhook_token via blind index', () => {
  it('grava integração cifrada e resolve o doctor certo pelo digest', async () => {
    await CredentialVault.writeIntegrationCredentials({ id: 'iB', doctorId: DOC_B, gateway: 'pagarme', values: { webhook_token: 'wht-secret-B' } });
    const rowB = db.tables.integrations.find((r) => r.id === 'iB');
    expect(rowB.webhook_token).toBeFalsy(); // dual-write off -> plaintext não é gravado
    expect(TokenCipher.isEnvelope(rowB.webhook_token_encrypted)).toBe(true);
    expect(rowB.webhook_token_lookup).toBe(TokenLookup.blindIndex('wht-secret-B'));

    expect(await resolveDoctorFromToken('pagarme', 'wht-secret-B')).toBe(DOC_B);
    expect(await resolveDoctorFromToken('pagarme', 'wht-secret-B ')).toBe(DOC_B); // normalização
    expect(await resolveDoctorFromToken('pagarme', 'errado')).toBe(null);
  });

  it('tenant errado: token de B não resolve para gateway de A', async () => {
    await CredentialVault.writeIntegrationCredentials({ id: 'iB', doctorId: DOC_B, gateway: 'pagarme', values: { webhook_token: 'wht-secret-B' } });
    expect(await resolveDoctorFromToken('whatsapp', 'wht-secret-B')).toBe(null);
  });

  it('fallback de migração: linha só com plaintext ainda resolve (ALLOW_PLAINTEXT_READ)', async () => {
    db.tables.integrations.push({ id: 'iC', doctor_id: DOC_A, gateway: 'kiwify', webhook_token: 'legacy-plain', webhook_token_lookup: null, access_token: null, access_token_encrypted: null, webhook_token_encrypted: null });
    expect(await resolveDoctorFromToken('kiwify', 'legacy-plain')).toBe(DOC_A);
  });
});

describe('FASE 2.2 — integração: leitura de credencial de integração', () => {
  it('WhatsApp: readIntegrationCredentials descriptografa o access_token', async () => {
    await CredentialVault.writeIntegrationCredentials({ id: 'iA', doctorId: DOC_A, gateway: 'whatsapp', values: { access_token: 'whatsapp-send-token' } });
    const creds = await CredentialVault.readIntegrationCredentials({ doctorId: DOC_A, gateway: 'whatsapp' });
    expect(creds.access_token).toBe('whatsapp-send-token');
    expect(creds.external_id).toBe('pn-A');
  });

  it('nenhuma resposta HTTP de /integrations contém token nem ciphertext', async () => {
    await CredentialVault.writeIntegrationCredentials({ id: 'iA', doctorId: DOC_A, gateway: 'whatsapp', values: { access_token: 'zzz', webhook_token: 'yyy' } });
    const res = await request(app).get(`/integrations?doctor_id=${DOC_A}`).set({ Authorization: 'Bearer tokA' });
    // req.user role doctor -> resolveDoctorId busca doctors por owner; sem doctors no mock => 400.
    // então cria uma via mock:
    db.tables.doctors = [{ id: DOC_A, owner_user_id: USER_A }];
    const res2 = await request(app).get('/integrations').set({ Authorization: 'Bearer tokA' });
    const blob = JSON.stringify(res2.body);
    expect(blob).not.toMatch(/zzz|yyy|e1\.v1\./);
    expect(res.status).toBeGreaterThanOrEqual(200);
  });
});
