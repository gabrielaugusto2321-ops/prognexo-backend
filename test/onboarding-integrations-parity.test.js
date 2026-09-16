// Hotfix: "Primeiros passos" (GET /onboarding) e "Integrações" (GET /integrations)
// deixam de calcular "conectado" cada um do seu jeito — ambos usam agora
// src/lib/integrationStatus.js. Este teste prova a PARIDADE entre as duas
// rotas para o mesmo médico, no nível HTTP (não só na função isolada).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));

const { app } = await import('../src/server.js');

const USER = '00000000-0000-4000-8000-0000000000u1';
const DOC_A = '00000000-0000-4000-8000-00000000000a';
const DOC_B = '00000000-0000-4000-8000-00000000000b';

function seed({ integrations = [], leads = [], deals = [], transactions = [], userDoctorAccess = [] } = {}) {
  db = makeDb({
    users: [{ id: USER, role: 'admin', ativo: true }],
    doctors: [{ id: DOC_A, ia_nome_agente: 'Ana' }, { id: DOC_B, ia_nome_agente: 'Bea' }],
    integrations,
    leads,
    deals,
    transactions,
    user_doctor_access: userDoctorAccess,
  });
  db.setAuthUser('admin', { id: USER });
}

const getOnboarding = (doctorId) =>
  request(app).get('/onboarding').query({ doctor_id: doctorId }).set({ Authorization: 'Bearer admin' });
const getIntegrations = (doctorId) =>
  request(app).get('/integrations').query({ doctor_id: doctorId }).set({ Authorization: 'Bearer admin' });

describe('Paridade WhatsApp — onboarding vs integrações', () => {
  const ORIGINAL_SYS_TOKEN = process.env.META_SYSTEM_USER_TOKEN;
  afterEach(() => {
    if (ORIGINAL_SYS_TOKEN === undefined) delete process.env.META_SYSTEM_USER_TOKEN;
    else process.env.META_SYSTEM_USER_TOKEN = ORIGINAL_SYS_TOKEN;
  });

  it('só external_id (cenário do Dr. Samuel), COM token de sistema configurado: as duas rotas concordam em true', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'sys-token';
    seed({ integrations: [{ id: 'i1', doctor_id: DOC_A, gateway: 'whatsapp', external_id: '5511999999999' }] });

    const onboarding = await getOnboarding(DOC_A);
    const integrations = await getIntegrations(DOC_A);
    const waRow = integrations.body.find((i) => i.gateway === 'whatsapp');

    expect(onboarding.body.whatsapp).toBe(true);
    expect(waRow.whatsapp_operacional).toBe(true);
  });

  it('só external_id, SEM token de sistema e sem token próprio: as duas rotas concordam em false', async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    seed({ integrations: [{ id: 'i1', doctor_id: DOC_A, gateway: 'whatsapp', external_id: '5511999999999' }] });

    const onboarding = await getOnboarding(DOC_A);
    const integrations = await getIntegrations(DOC_A);
    const waRow = integrations.body.find((i) => i.gateway === 'whatsapp');

    expect(onboarding.body.whatsapp).toBe(false);
    expect(waRow.whatsapp_operacional).toBe(false);
  });

  it('external_id + access_token próprio: as duas rotas concordam em true, mesmo sem token de sistema', async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    seed({ integrations: [{ id: 'i1', doctor_id: DOC_A, gateway: 'whatsapp', external_id: '5511999999999', access_token: 'token-proprio' }] });

    const onboarding = await getOnboarding(DOC_A);
    const integrations = await getIntegrations(DOC_A);
    const waRow = integrations.body.find((i) => i.gateway === 'whatsapp');

    expect(onboarding.body.whatsapp).toBe(true);
    expect(waRow.whatsapp_operacional).toBe(true);
  });

  it('só waba_id (Embedded Signup incompleto, sem token de nenhum tipo): as duas rotas concordam em false', async () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    seed({ integrations: [{ id: 'i1', doctor_id: DOC_A, gateway: 'whatsapp', waba_id: 'wid-123' }] });

    const onboarding = await getOnboarding(DOC_A);
    const integrations = await getIntegrations(DOC_A);
    const waRow = integrations.body.find((i) => i.gateway === 'whatsapp');

    expect(onboarding.body.whatsapp).toBe(false);
    expect(waRow.whatsapp_operacional).toBe(false);
  });

  it('resposta de GET /integrations nunca inclui access_token em texto puro', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'sys-token';
    seed({ integrations: [{ id: 'i1', doctor_id: DOC_A, gateway: 'whatsapp', external_id: '5511999999999', access_token: 'segredo-nao-pode-vazar' }] });

    const integrations = await getIntegrations(DOC_A);
    const raw = JSON.stringify(integrations.body);
    expect(raw).not.toContain('segredo-nao-pode-vazar');
    expect(raw).not.toContain('access_token"');
  });
});

describe('Paridade pagamento — onboarding vs integrações', () => {
  it('sem nenhuma transação: onboarding.pagamento=false e todos os gateways aguardando webhook', async () => {
    seed({});
    const onboarding = await getOnboarding(DOC_A);
    const integrations = await getIntegrations(DOC_A);

    expect(onboarding.body.pagamento).toBe(false);
    for (const row of integrations.body) {
      if (row.gateway === 'whatsapp') continue;
      expect(row.webhook_recebido).toBe(false);
    }
  });

  it('transação de status "pendente" (não "pago") num gateway: onboarding.pagamento=true e webhook_recebido=true SÓ nesse gateway', async () => {
    seed({
      leads: [{ id: 'lA1', doctor_id: DOC_A }],
      deals: [{ id: 'dA1', lead_id: 'lA1' }],
      transactions: [{ id: 't1', deal_id: 'dA1', gateway: 'kiwify', status: 'pendente' }],
    });

    const onboarding = await getOnboarding(DOC_A);
    const integrations = await getIntegrations(DOC_A);
    const porGateway = Object.fromEntries(integrations.body.map((r) => [r.gateway, r]));

    expect(onboarding.body.pagamento).toBe(true);
    expect(porGateway.kiwify.webhook_recebido).toBe(true);
    expect(porGateway.hotmart.webhook_recebido).toBe(false);
    expect(porGateway.ticto.webhook_recebido).toBe(false);
    expect(porGateway.pagarme.webhook_recebido).toBe(false);
  });

  it('médico A nunca herda pagamento/webhook do médico B', async () => {
    seed({
      leads: [{ id: 'lB1', doctor_id: DOC_B }],
      deals: [{ id: 'dB1', lead_id: 'lB1' }],
      transactions: [{ id: 't1', deal_id: 'dB1', gateway: 'hotmart', status: 'pago' }],
    });

    const onboardingA = await getOnboarding(DOC_A);
    const integrationsA = await getIntegrations(DOC_A);
    const onboardingB = await getOnboarding(DOC_B);
    const integrationsB = await getIntegrations(DOC_B);

    expect(onboardingA.body.pagamento).toBe(false);
    expect(integrationsA.body.find((r) => r.gateway === 'hotmart').webhook_recebido).toBe(false);

    expect(onboardingB.body.pagamento).toBe(true);
    expect(integrationsB.body.find((r) => r.gateway === 'hotmart').webhook_recebido).toBe(true);
  });
});
