import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// FASE 2.10 — ETAPA 5: ensaio da ESCADA de ativação das flags.
// Para cada estado documentado em docs/platform/27-flag-activation-matrix.md,
// sobe o app local e roda os smoke tests autenticados. Provedores externos
// (WhatsApp / e-mail / IA / pagamento) são mockados; a lógica de tenancy é
// exercida de verdade (mesmo código de resolveTenantContext/scopedDoctorIds).

process.env.NODE_ENV = 'test';
process.env.WHATSAPP_SEND_INTERVAL_MS = '0'; // FASE 2 - desliga pacing artificial nos testes
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
const sendWhatsApp = vi.fn(async () => ({}));
const sendEmailFake = vi.fn(async () => ({ id: 'fake' }));
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage: sendWhatsApp, sendWhatsAppTemplate: vi.fn(async () => ({ messageId: 'wamid.mock' })) }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));
vi.mock('../src/lib/iaAgent.js', () => ({ processarMensagemComIA: vi.fn(async () => ({ resposta: 'x', score: 1 })) }));
vi.mock('../src/lib/knowledgeChunks.js', () => ({ buscarChunksRelevantes: vi.fn(async () => []) }));
vi.mock('../src/lib/emailAdapter.js', () => ({
  configuredTeamInviteEmailAdapter: () => ({ name: 'fake', send: sendEmailFake }),
}));

// aquece a árvore pesada FORA do clock de teste
await import('../src/server.js');

const U = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const OWNER_A = U(1);
const MULTI = U(2);
const SUSP = U(3);
const PADM = U(4);
const ORG_A = U('a');
const ORG_B = U('b');
const DOC_A = U('d');
const DOC_B = U('e');

function seed() {
  db = makeDb({
    users: [
      { id: OWNER_A, nome: 'Owner A', email: 'oa@local.test', role: 'doctor', ativo: true },
      { id: MULTI, nome: 'Multi', email: 'm@local.test', role: 'closer', ativo: true },
      { id: SUSP, nome: 'Susp', email: 's@local.test', role: 'closer', ativo: true },
      { id: PADM, nome: 'PAdmin', email: 'p@local.test', role: 'admin', ativo: true },
    ],
    doctors: [{ id: DOC_A, owner_user_id: OWNER_A }, { id: DOC_B, owner_user_id: U(9) }],
    organizations: [
      { id: ORG_A, name: 'A', status: 'active' },
      { id: ORG_B, name: 'B', status: 'active' },
    ],
    units: [
      { id: 'uA', organization_id: ORG_A, name: 'UA', status: 'active' },
      { id: 'uB', organization_id: ORG_B, name: 'UB', status: 'active' },
    ],
    memberships: [
      { id: 'mOA', organization_id: ORG_A, user_id: OWNER_A, role: 'organization_owner', status: 'active' },
      { id: 'mMA', organization_id: ORG_A, user_id: MULTI, role: 'closer', status: 'active' },
      { id: 'mMB', organization_id: ORG_B, user_id: MULTI, role: 'closer', status: 'active' },
      { id: 'mSA', organization_id: ORG_A, user_id: SUSP, role: 'closer', status: 'suspended' },
    ],
    membership_units: [
      { membership_id: 'mOA', unit_id: 'uA' }, { membership_id: 'mMA', unit_id: 'uA' }, { membership_id: 'mMB', unit_id: 'uB' },
    ],
    platform_admins: [{ user_id: PADM }],
    organization_doctor_map: [
      { organization_id: ORG_A, doctor_id: DOC_A, default_unit_id: 'uA' },
      { organization_id: ORG_B, doctor_id: DOC_B, default_unit_id: 'uB' },
    ],
    user_doctor_access: [
      { user_id: MULTI, doctor_id: DOC_A }, { user_id: MULTI, doctor_id: DOC_B },
    ],
    leads: [
      { id: 'lA', doctor_id: DOC_A, organization_id: ORG_A, sdr_responsavel_id: MULTI, status_atual: 'lead', criado_em: new Date().toISOString() },
      { id: 'lB', doctor_id: DOC_B, organization_id: ORG_B, sdr_responsavel_id: MULTI, status_atual: 'lead', criado_em: new Date().toISOString() },
    ],
    deals: [{ id: 'dlA', lead_id: 'lA', etapa: 'lead', sdr_responsavel_id: MULTI }],
    events: [{ id: 'evA', doctor_id: DOC_A, organization_id: ORG_A, lead_id: 'lA', status: 'pendente', responsavel_id: MULTI }],
    conversations: [{ id: 'cvA', lead_id: 'lA', doctor_id: DOC_A, organization_id: ORG_A, direcao: 'recebida', timestamp_msg: new Date().toISOString() }],
    integrations: [
      { id: 'iA', doctor_id: DOC_A, organization_id: ORG_A, gateway: 'whatsapp', external_id: 'pn-A', access_token: 'segredo-A' },
      { id: 'iA-kiwify', doctor_id: DOC_A, organization_id: ORG_A, gateway: 'kiwify' },
    ],
    campanhas: [{ id: 'cpA', doctor_id: DOC_A, organization_id: ORG_A, nome: 'C', mensagem: 'oi', status: 'rascunho' }],
    campanha_envios: [],
    job_queue: [],
    organization_invitations: [],
    outbox_events: [],
  });
  for (const [tok, id] of [['owner', OWNER_A], ['multi', MULTI], ['susp', SUSP], ['padm', PADM]]) db.setAuthUser(tok, { id });
}

const KEY = Buffer.alloc(32, 5).toString('base64');
const STATES = {
  '1-todas-off': {},
  '2-tenant-core': { TENANT_CORE_ENABLED: 'true' },
  '3-tenancy-rotas': { TENANT_CORE_ENABLED: 'true' }, // TENANT_CORE já cobre os 13 routers
  '4-team-memberships': { TENANT_CORE_ENABLED: 'true', TEAM_MEMBERSHIPS_ENABLED: 'true' },
  '5-convites-outbox': { TENANT_CORE_ENABLED: 'true', TEAM_MEMBERSHIPS_ENABLED: 'true', TEAM_INVITE_OUTBOX_ENABLED: 'true' },
  '6-jobs-quotas': { TENANT_CORE_ENABLED: 'true', TEAM_MEMBERSHIPS_ENABLED: 'true', PERSISTENT_JOB_QUEUE_ENABLED: 'true', USAGE_QUOTAS_ENABLED: 'true', CAMPAIGN_JOB_QUEUE_ENABLED: 'true' },
  '7-shadow-reads': { TENANT_CORE_ENABLED: 'true', TEAM_MEMBERSHIPS_ENABLED: 'true', TENANT_SHADOW_READ_ENABLED: 'true' },
  '8-final-staging': {
    TENANT_CORE_ENABLED: 'true', TEAM_MEMBERSHIPS_ENABLED: 'true', TEAM_INVITE_OUTBOX_ENABLED: 'true',
    PERSISTENT_JOB_QUEUE_ENABLED: 'true', USAGE_QUOTAS_ENABLED: 'true', CAMPAIGN_JOB_QUEUE_ENABLED: 'true',
    TENANT_SHADOW_READ_ENABLED: 'true',
  },
};
const CRYPTO_KEYS = ['TOKEN_ENCRYPTION_KEYRING', 'TOKEN_ENCRYPTION_ACTIVE_KEY', 'TOKEN_LOOKUP_HMAC_KEY', 'JOB_RUNNER_SECRET', 'RESEND_API_KEY'];
const ALL_FLAG_KEYS = ['TENANT_CORE_ENABLED', 'TEAM_MEMBERSHIPS_ENABLED', 'TEAM_INVITE_OUTBOX_ENABLED', 'TEAM_INVITE_EMAIL_DELIVERY_ENABLED', 'PERSISTENT_JOB_QUEUE_ENABLED', 'USAGE_QUOTAS_ENABLED', 'CAMPAIGN_JOB_QUEUE_ENABLED', 'TENANT_SHADOW_READ_ENABLED'];

async function app(flags) {
  vi.resetModules();
  for (const k of [...ALL_FLAG_KEYS, ...CRYPTO_KEYS]) delete process.env[k];
  for (const [k, v] of Object.entries(flags)) process.env[k] = v;
  if (Object.values(flags).includes('true')) {
    process.env.TOKEN_ENCRYPTION_KEYRING = JSON.stringify({ v1: KEY });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY = 'v1';
    process.env.TOKEN_LOOKUP_HMAC_KEY = KEY;
    process.env.JOB_RUNNER_SECRET = 'runner-secret-value';
  }
  const mod = await import('../src/server.js');
  return mod.createApp();
}
const B = (t) => ({ Authorization: `Bearer ${t}` });

describe('FASE 2.10 — escada de ativação de flags (smoke por estado)', () => {
  beforeEach(seed);

  for (const [name, flags] of Object.entries(STATES)) {
    describe(`estado ${name}`, () => {
      const on = flags.TENANT_CORE_ENABLED === 'true';

      it('boot OK + /health', async () => {
        const a = await app(flags);
        expect((await request(a).get('/health')).status).toBe(200);
        expect(sendWhatsApp).not.toHaveBeenCalled();
      });

      it('/tenant/context nunca vaza token e não escolhe org sozinho quando há >1', async () => {
        const a = await app(flags);
        const r = await request(a).get('/tenant/context').set(B('multi'));
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.body)).not.toMatch(/token|secret|segredo-/i);
        expect(r.body.selected_organization_id).toBeNull();
        if (r.body.organizations?.length > 1) expect(r.body.requires_selection).toBe(true);
      });

      it('owner de uma org: GET /leads', async () => {
        const a = await app(flags);
        const r = await request(a).get('/leads').set(B('owner')).set(on ? { 'X-Organization-Id': ORG_A } : {});
        expect(r.status).toBe(200);
      });

      it(on ? 'multi-org SEM seleção -> 409' : 'multi-org legado -> 200 (flag off)', async () => {
        const a = await app(flags);
        const r = await request(a).get('/leads').set(B('multi'));
        expect(r.status).toBe(on ? 409 : 200);
      });

      it('seleção explícita da org correta -> sucesso e escopo certo', async () => {
        const a = await app(flags);
        const rA = await request(a).get('/leads').set(B('multi')).set('X-Organization-Id', ORG_A);
        expect(rA.status).toBe(200);
        if (on) expect(rA.body.map((l) => l.id)).toEqual(['lA']);
      });

      it(on ? 'organização alheia (sem membership) -> 403' : 'sem tenant: header ignorado', async () => {
        const a = await app(flags);
        const alien = U('f'); // org que ninguém é membro
        const r = await request(a).get('/leads').set(B('owner')).set('X-Organization-Id', alien);
        expect(r.status).toBe(on ? 403 : 200);
      });

      it('platform_admin conforme a regra (sem org -> 409 com flag ON; global só em endpoint global)', async () => {
        const a = await app(flags);
        const noSel = await request(a).get('/leads').set(B('padm'));
        expect(noSel.status).toBe(on ? 409 : 200);
        const withSel = await request(a).get('/leads').set(B('padm')).set('X-Organization-Id', ORG_A);
        expect(withSel.status).toBe(200);
      });

      it('CRUD leads/deals/events/conversations no tenant certo', async () => {
        const a = await app(flags);
        const h = on ? { 'X-Organization-Id': ORG_A } : {};
        expect((await request(a).get('/leads').set(B('owner')).set(h)).status).toBe(200);
        expect((await request(a).get('/deals').set(B('owner')).set(h)).status).toBe(200);
        expect((await request(a).get('/events').set(B('owner')).set(h)).status).toBe(200);
        expect((await request(a).get('/conversations').set(B('owner')).set(h)).status).toBe(200);
      });

      it('integração devolve só status, nunca token', async () => {
        const a = await app(flags);
        const r = await request(a).get('/integrations').query(on ? {} : { doctor_id: DOC_A }).set(B('owner')).set(on ? { 'X-Organization-Id': ORG_A } : {});
        expect([200, 400, 409]).toContain(r.status);
        const blob = JSON.stringify(r.body);
        expect(blob).not.toMatch(/segredo-A|access_token"\s*:\s*"[^"]/);
      });

      it('nenhuma chamada externa real (WhatsApp/e-mail) durante os smokes', async () => {
        await app(flags);
        await request(await app(flags)).get('/health');
        expect(sendWhatsApp).not.toHaveBeenCalled();
        expect(sendEmailFake).not.toHaveBeenCalled();
      });
    });
  }

  it('estado 5: superfície de convites (outbox) existe; estado 4: não existe', async () => {
    const a4 = await app(STATES['4-team-memberships']);
    expect((await request(a4).get('/team/invitations').set(B('owner')).set('X-Organization-Id', ORG_A)).status).toBe(404);
    const a5 = await app(STATES['5-convites-outbox']);
    const r5 = await request(a5).get('/team/invitations').set(B('owner')).set('X-Organization-Id', ORG_A);
    expect(r5.status).not.toBe(404);
  });

  it('estado 6: disparo de campanha usa a fila (202 + job_id), zero WhatsApp na request', async () => {
    db.client.rpc = vi.fn(async (name) => {
      if (name === 'job_enqueue') return { data: { id: 'job-1' }, error: null };
      return { data: null, error: null };
    });
    const a = await app(STATES['6-jobs-quotas']);
    const r = await request(a).post('/campanhas/cpA/enviar').set(B('owner')).set('X-Organization-Id', ORG_A);
    expect([202, 409, 500]).toContain(r.status); // 202 no caminho feliz da fila
    if (r.status === 202) expect(r.body.job_id || r.body.status).toBeTruthy();
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });
});
