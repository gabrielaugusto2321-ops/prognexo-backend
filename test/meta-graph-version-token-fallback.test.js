import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { makeDb } from './helpers/mockSupabase.js';

// Chaves FALSAS geradas no teste — nunca chaves reais.
const KEYRING = JSON.stringify({ v1: crypto.randomBytes(32).toString('base64') });
process.env.NODE_ENV = 'test';
process.env.WHATSAPP_SEND_INTERVAL_MS = '0'; // FASE 2 - desliga pacing artificial nos testes
process.env.TOKEN_ENCRYPTION_ENABLED = 'true';
process.env.TOKEN_ENCRYPTION_DUAL_WRITE = 'false';
process.env.TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ = 'true'; // janela de migração
process.env.TOKEN_ENCRYPTION_KEYRING = KEYRING;
process.env.TOKEN_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.TOKEN_LOOKUP_HMAC_KEY = crypto.randomBytes(48).toString('base64');
process.env.META_SYSTEM_USER_TOKEN = 'system-fallback-token';

let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));

const { validateEnv } = await import('../src/config/env.js');
const { CredentialVault } = await import('../src/lib/credentialVault.js');
const { handleCampaignSendJob } = await import('../src/jobs/campaignSendHandler.js');

const DOC = '00000000-0000-4000-8000-00000000000d';

function integrationRow(overrides = {}) {
  return {
    id: 'i1',
    doctor_id: DOC,
    gateway: 'whatsapp',
    external_id: 'pn-1',
    access_token: null,
    webhook_token: null,
    access_token_encrypted: null,
    webhook_token_encrypted: null,
    ...overrides,
  };
}

describe('META_GRAPH_API_VERSION — fonte única de verdade', () => {
  it('valor padrão v26.0 quando a variável não é definida', () => {
    const env = validateEnv({ NODE_ENV: 'test' });
    expect(env.META_GRAPH_API_VERSION).toBe('v26.0');
  });

  it('aceita override válido via META_GRAPH_API_VERSION', () => {
    const env = validateEnv({ NODE_ENV: 'test', META_GRAPH_API_VERSION: 'v21.3' });
    expect(env.META_GRAPH_API_VERSION).toBe('v21.3');
  });

  it('valor inválido falha de forma segura (fail-fast, nunca usa um valor fora do padrão)', () => {
    expect(() => validateEnv({ NODE_ENV: 'test', META_GRAPH_API_VERSION: 'vXY' })).toThrow(/Invalid environment configuration/);
    expect(() => validateEnv({ NODE_ENV: 'test', META_GRAPH_API_VERSION: '26.0' })).toThrow();
    expect(() => validateEnv({ NODE_ENV: 'test', META_GRAPH_API_VERSION: 'v26' })).toThrow();
  });

  it('whatsapp.js e embeddedSignup.js consomem a MESMA versão centralizada', async () => {
    vi.resetModules();
    process.env.META_GRAPH_API_VERSION = 'v99.5';
    const { sendWhatsAppMessage } = await import('../src/lib/whatsapp.js');
    const { exchangeCodeForToken } = await import('../src/lib/embeddedSignup.js');
    const calledUrls = [];
    global.fetch = vi.fn(async (url) => {
      calledUrls.push(String(url));
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }], access_token: 'x' }) };
    });
    await sendWhatsAppMessage('pn-1', 'tok', '5511999', 'oi');
    await exchangeCodeForToken('code-1');
    expect(calledUrls).toHaveLength(2);
    for (const url of calledUrls) expect(url).toContain('/v99.5/');
    delete process.env.META_GRAPH_API_VERSION;
    vi.resetModules();
  });

  it('Embedded Signup usa explicitamente o token do cliente ao registrar o número e inscrever a WABA', async () => {
    vi.resetModules();
    const { registerPhoneNumber, subscribeAppToWaba } = await import('../src/lib/embeddedSignup.js');
    const calls = [];
    global.fetch = vi.fn(async (url, opts) => {
      calls.push({ url: String(url), opts });
      return { ok: true, json: async () => ({ success: true }) };
    });

    await registerPhoneNumber('phone-client', 'client-business-token');
    await subscribeAppToWaba('waba-client', 'client-business-token');

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.opts.headers.Authorization).toBe('Bearer client-business-token');
      expect(call.opts.headers.Authorization).not.toContain('system-fallback-token');
    }
    vi.resetModules();
  });

  it('payload de texto livre permanece byte/logicamente equivalente, só a versão na URL muda', async () => {
    vi.resetModules();
    const { sendWhatsAppMessage } = await import('../src/lib/whatsapp.js');
    let capturedUrl;
    let capturedBody;
    global.fetch = vi.fn(async (url, opts) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.2' }] }) };
    });
    await sendWhatsAppMessage('pn-1', 'tok-abc', '5511999', 'mensagem livre');
    expect(capturedUrl).toBe('https://graph.facebook.com/v26.0/pn-1/messages');
    expect(capturedBody).toEqual({
      messaging_product: 'whatsapp',
      to: '5511999',
      type: 'text',
      text: { body: 'mensagem livre' },
    });
    vi.resetModules();
  });
});

describe('CredentialVault.resolveWhatsAppSendCredentials — resolução única do token', () => {
  beforeEach(() => {
    db = makeDb({ integrations: [integrationRow()] });
  });

  it('token individual (plaintext) tem precedência sobre o fallback de sistema', async () => {
    await CredentialVault.writeIntegrationCredentials({ id: 'i1', doctorId: DOC, gateway: 'whatsapp', values: { access_token: 'individual-tok' } });
    const creds = await CredentialVault.resolveWhatsAppSendCredentials({ doctorId: DOC });
    expect(creds.accessToken).toBe('individual-tok');
    expect(creds.externalId).toBe('pn-1');
  });

  it('token individual cifrado é resolvido pelo mecanismo de descriptografia existente (TokenCipher)', async () => {
    await CredentialVault.writeIntegrationCredentials({ id: 'i1', doctorId: DOC, gateway: 'whatsapp', values: { access_token: 'encrypted-tok' } });
    const row = db.tables.integrations.find((r) => r.id === 'i1');
    expect(row.access_token).toBeFalsy(); // dual-write off -> só ciphertext persistido
    expect(row.access_token_encrypted).toMatch(/^e1\./);
    const creds = await CredentialVault.resolveWhatsAppSendCredentials({ doctorId: DOC });
    expect(creds.accessToken).toBe('encrypted-tok');
  });

  it('sem token individual -> cai para META_SYSTEM_USER_TOKEN (fallback)', async () => {
    const creds = await CredentialVault.resolveWhatsAppSendCredentials({ doctorId: DOC, systemToken: 'sys-fallback' });
    expect(creds.accessToken).toBe('sys-fallback');
    expect(creds.externalId).toBe('pn-1');
  });

  it('ausência de qualquer token (individual e sistema) bloqueia o envio', async () => {
    // systemToken precisa ser passado explicitamente como "ausente" (null) —
    // undefined dispararia o valor padrão real de META_SYSTEM_USER_TOKEN.
    const creds = await CredentialVault.resolveWhatsAppSendCredentials({ doctorId: DOC, systemToken: null });
    expect(creds.accessToken).toBeNull();
  });

  it('integração inexistente -> nem externalId nem token', async () => {
    const creds = await CredentialVault.resolveWhatsAppSendCredentials({ doctorId: 'doctor-sem-integracao', systemToken: 'sys' });
    expect(creds.externalId).toBeNull();
    expect(creds.accessToken).toBe('sys'); // fallback de sistema não depende de existir integração
  });
});

describe('campaignSendHandler — worker usa external_id + META_SYSTEM_USER_TOKEN (correção do bug)', () => {
  it('envia normalmente quando a integração NÃO tem token próprio, só o do sistema', async () => {
    db = makeDb({
      campanhas: [{ id: 'camp-1', doctor_id: DOC, organization_id: 'org-1', mensagem: 'oi', status: 'processando' }],
      leads: [{ id: 'lead-1', doctor_id: DOC, telefone: '551199', telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado' }],
      conversations: [{ lead_id: 'lead-1', direcao: 'recebida', timestamp_msg: new Date().toISOString() }],
      campanha_envios: [{ campanha_id: 'camp-1', lead_id: 'lead-1', status: 'enviando' }],
      integrations: [integrationRow({ id: 'i2', external_id: 'pn-only-system' })],
    });
    const send = vi.fn(async () => ({}));
    const queue = {
      decodePayload: () => ({ campaignId: 'camp-1', leadId: 'lead-1', doctorId: DOC }),
      complete: vi.fn(async () => {}),
      retry: vi.fn(async () => ({ status: 'retry' })),
    };
    const quota = {
      reserve: vi.fn(async () => ({ allowed: true, reservationId: 'rv-1' })),
      settle: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const job = { id: 'job-1', organization_id: 'org-1', job_type: 'campaign.send_message', attempts: 0, payload: {} };

    const ok = await handleCampaignSendJob(job, {
      workerId: 'w1', client: db.client, queue, quota, send, credentialVault: CredentialVault,
    });

    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledWith('pn-only-system', 'system-fallback-token', '5511987654321', 'oi');
    expect(quota.reserve).toHaveBeenCalledTimes(1);
    expect(quota.settle).toHaveBeenCalledTimes(1);
  });

  it('sem token individual e sem META_SYSTEM_USER_TOKEN -> missing_resource, nunca chama send', async () => {
    db = makeDb({
      campanhas: [{ id: 'camp-3', doctor_id: DOC, organization_id: 'org-1', mensagem: 'oi', status: 'processando' }],
      leads: [{ id: 'lead-3', doctor_id: DOC, telefone: '551199', telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado' }],
      conversations: [{ lead_id: 'lead-3', direcao: 'recebida', timestamp_msg: new Date().toISOString() }],
      campanha_envios: [{ campanha_id: 'camp-3', lead_id: 'lead-3', status: 'enviando' }],
      integrations: [integrationRow({ id: 'i4', external_id: 'pn-4' })],
    });
    const send = vi.fn(async () => ({}));
    const queue = {
      decodePayload: () => ({ campaignId: 'camp-3', leadId: 'lead-3', doctorId: DOC }),
      complete: vi.fn(async () => {}),
      retry: vi.fn(async (args) => { expect(args.errorCode).toBe('missing_resource'); return { status: 'retry' }; }),
    };
    const quota = { reserve: vi.fn(async () => ({ allowed: true, reservationId: 'rv-3' })), settle: vi.fn(async () => {}), release: vi.fn(async () => {}) };
    const job = { id: 'job-3', organization_id: 'org-1', job_type: 'campaign.send_message', attempts: 0, payload: {} };

    // Simula a ausência de META_SYSTEM_USER_TOKEN (o processo de teste tem a
    // variável configurada globalmente para os outros cenários) injetando um
    // credentialVault que reproduz exatamente essa saída de resolução.
    const ok = await handleCampaignSendJob(job, {
      workerId: 'w1', client: db.client, queue, quota, send,
      credentialVault: { resolveWhatsAppSendCredentials: async () => ({ externalId: 'pn-4', accessToken: null }) },
    });
    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('nenhum token aparece em erro/log quando o envio falha', async () => {
    db = makeDb({
      campanhas: [{ id: 'camp-2', doctor_id: DOC, organization_id: 'org-1', mensagem: 'oi', status: 'processando' }],
      leads: [{ id: 'lead-2', doctor_id: DOC, telefone: '551199', telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado' }],
      conversations: [{ lead_id: 'lead-2', direcao: 'recebida', timestamp_msg: new Date().toISOString() }],
      campanha_envios: [{ campanha_id: 'camp-2', lead_id: 'lead-2', status: 'enviando' }],
      integrations: [integrationRow({ id: 'i3', external_id: 'pn-3', access_token: 'super-secret-individual-token' })],
    });
    const secretToken = 'super-secret-individual-token';
    const send = vi.fn(async () => { throw new Error(`Meta rejected token ${secretToken}`); });
    const logs = [];
    const log = { error: (obj, msg) => logs.push(`${JSON.stringify(obj)} ${msg}`) };
    const queue = {
      decodePayload: () => ({ campaignId: 'camp-2', leadId: 'lead-2', doctorId: DOC }),
      complete: vi.fn(async () => {}),
      retry: vi.fn(async () => ({ status: 'retry' })),
    };
    const quota = { reserve: vi.fn(async () => ({ allowed: true, reservationId: 'rv-2' })), settle: vi.fn(async () => {}), release: vi.fn(async () => {}) };
    const job = { id: 'job-2', organization_id: 'org-1', job_type: 'campaign.send_message', attempts: 0, payload: {} };

    const ok = await handleCampaignSendJob(job, {
      workerId: 'w1', client: db.client, queue, quota, send, credentialVault: CredentialVault, log,
    });

    expect(ok).toBe(false);
    const combined = logs.join(' ');
    expect(combined).not.toContain(secretToken);
    expect(combined).not.toContain('individual-tok'); // nenhuma variação de token vaza
  });
});
