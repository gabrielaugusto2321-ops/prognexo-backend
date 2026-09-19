import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
process.env.TOKEN_ENCRYPTION_ENABLED = 'true';
process.env.TOKEN_ENCRYPTION_DUAL_WRITE = 'false';
process.env.TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ = 'false';
process.env.TOKEN_ENCRYPTION_KEYRING = JSON.stringify({ v1: crypto.randomBytes(32).toString('base64') });
process.env.TOKEN_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.TOKEN_LOOKUP_HMAC_KEY = crypto.randomBytes(48).toString('base64');

let db;
const embedded = vi.hoisted(() => ({
  exchangeCodeForToken: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeAppToWaba: vi.fn(),
}));

vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/embeddedSignup.js', () => embedded);

const { app } = await import('../src/server.js');
const { CredentialVault } = await import('../src/lib/credentialVault.js');

const OWNER = '00000000-0000-4000-8100-0000000ow01';
const DOC = '00000000-0000-4000-8100-0000000da01';

beforeEach(() => {
  embedded.exchangeCodeForToken.mockReset().mockResolvedValue('client-business-token');
  embedded.registerPhoneNumber.mockReset().mockResolvedValue({ success: true });
  embedded.subscribeAppToWaba.mockReset().mockResolvedValue({ success: true });
  db = makeDb({
    users: [{ id: OWNER, role: 'doctor', ativo: true }],
    doctors: [{ id: DOC, owner_user_id: OWNER, nome: 'Dr. Cliente' }],
    integrations: [{
      id: 'integration-1', doctor_id: DOC, gateway: 'whatsapp',
      external_id: null, waba_id: null, access_token: null,
    }],
  });
  db.setAuthUser('owner', { id: OWNER });
});

describe('POST /integrations/whatsapp/embedded-callback', () => {
  it('usa e persiste o token da conexão do próprio cliente, sem expô-lo na resposta', async () => {
    const res = await request(app)
      .post('/integrations/whatsapp/embedded-callback')
      .set({ Authorization: 'Bearer owner' })
      .send({ code: 'single-use-code', waba_id: 'waba-client', phone_number_id: 'phone-client' });

    expect(res.status).toBe(200);
    expect(embedded.exchangeCodeForToken).toHaveBeenCalledWith('single-use-code');
    expect(embedded.registerPhoneNumber).toHaveBeenCalledWith('phone-client', 'client-business-token');
    expect(embedded.subscribeAppToWaba).toHaveBeenCalledWith('waba-client', 'client-business-token');

    const integration = db.tables.integrations.find((row) => row.id === 'integration-1');
    expect(integration).toMatchObject({ external_id: 'phone-client', waba_id: 'waba-client' });
    expect(integration.access_token).toBeNull();
    expect(integration.access_token_encrypted).toMatch(/^e1\.v1\./);
    const stored = await CredentialVault.readIntegrationCredentials({ doctorId: DOC, gateway: 'whatsapp' });
    expect(stored.access_token).toBe('client-business-token');
    expect(JSON.stringify(res.body)).not.toContain('client-business-token');
    expect(res.body).toMatchObject({
      external_id: 'phone-client', waba_id: 'waba-client', conectado_via: 'embedded_signup',
    });
  });

  it('não marca a integração como conectada se a inscrição da WABA falhar', async () => {
    embedded.subscribeAppToWaba.mockRejectedValueOnce(new Error('subscription failed'));

    const res = await request(app)
      .post('/integrations/whatsapp/embedded-callback')
      .set({ Authorization: 'Bearer owner' })
      .send({ code: 'single-use-code', waba_id: 'waba-client', phone_number_id: 'phone-client' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('embedded_signup_failed');
    const integration = db.tables.integrations.find((row) => row.id === 'integration-1');
    expect(integration).toMatchObject({ external_id: null, waba_id: null, access_token: null });
    expect(integration.access_token_encrypted).toBeUndefined();
  });
});
