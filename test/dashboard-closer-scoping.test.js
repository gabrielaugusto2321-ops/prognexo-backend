import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));
afterEach(() => { delete process.env.TENANT_CORE_ENABLED; vi.resetModules(); });
afterAll(() => { delete process.env.TENANT_CORE_ENABLED; vi.resetModules(); });

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D1 = U(1); const D2 = U(2); const OWNER = U(11); const OWNER2 = U(12);
const A = U(21); const B = U(22); const OA = U(31); const ORG1 = U(41); const ORG2 = U(42); const UNIT = U(51);
const now = new Date().toISOString();
const auth = (token, org) => ({ Authorization: `Bearer ${token}`, ...(org ? { 'X-Organization-Id': org } : {}) });
async function app(flag) { vi.resetModules(); process.env.TENANT_CORE_ENABLED = flag; return (await import('../src/server.js')).createApp(); }

function seed() {
  db = makeDb({
    users: [{ id: OWNER, role: 'doctor', ativo: true }, { id: OWNER2, role: 'doctor', ativo: true }, { id: A, role: 'closer', ativo: true }, { id: B, role: 'closer', ativo: true }, { id: OA, role: 'doctor', ativo: true }],
    doctors: [{ id: D1, owner_user_id: OWNER }, { id: D2, owner_user_id: OWNER2 }],
    user_doctor_access: [{ user_id: A, doctor_id: D1 }, { user_id: B, doctor_id: D1 }],
    organizations: [{ id: ORG1 }, { id: ORG2 }], units: [{ id: UNIT, organization_id: ORG1 }],
    organization_doctor_map: [{ organization_id: ORG1, doctor_id: D1, default_unit_id: UNIT }, { organization_id: ORG2, doctor_id: D2 }],
    memberships: [{ id: 'ma', organization_id: ORG1, user_id: A, role: 'closer', status: 'active' }, { id: 'mo', organization_id: ORG1, user_id: OA, role: 'organization_owner', status: 'active' }],
    membership_units: [],
    leads: [
      { id: U(101), doctor_id: D1, sdr_responsavel_id: A, status_atual: 'conversa', atendido_por: 'humano', ia_motivo_handoff: 'score', ia_sem_resposta_count: 1, criado_em: now },
      { id: U(102), doctor_id: D1, sdr_responsavel_id: B, status_atual: 'fechado', atendido_por: 'humano', ia_motivo_handoff: 'score', ia_sem_resposta_count: 4, criado_em: now },
      { id: U(103), doctor_id: D2, sdr_responsavel_id: A, status_atual: 'fechado', atendido_por: 'humano', ia_motivo_handoff: 'score', ia_sem_resposta_count: 9, criado_em: now },
    ],
    deals: [{ id: U(201), lead_id: U(101) }, { id: U(202), lead_id: U(102) }, { id: U(203), lead_id: U(103) }],
    transactions: [{ id: U(301), deal_id: U(201), valor: 100, status: 'pago', criado_em: now }, { id: U(302), deal_id: U(202), valor: 200, status: 'pago', criado_em: now }, { id: U(303), deal_id: U(203), valor: 900, status: 'pago', criado_em: now }],
    conversations: [{ lead_id: U(101), direcao: 'recebida', origem: 'whatsapp', timestamp_msg: now }, { lead_id: U(102), direcao: 'recebida', origem: 'whatsapp', timestamp_msg: now }, { lead_id: U(103), direcao: 'recebida', origem: 'whatsapp', timestamp_msg: now }],
    platform_admins: [],
  });
  for (const [t, id] of [['a', A], ['owner', OWNER], ['oa', OA]]) db.setAuthUser(t, { id });
}

describe('GET /dashboard scoping', () => {
  beforeEach(seed);
  it('legacy closer sees only their leads, handoffs and revenue', async () => {
    const res = await request(await app('false')).get('/dashboard').set(auth('a'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total_leads: 1, fechamentos: 0, receita_gerada: 100, precisam_de_voce: 1, ia_perguntas_sem_resposta: 1 });
  });
  it('legacy doctor sees the whole clinic but no other doctor revenue', async () => {
    const res = await request(await app('false')).get('/dashboard').set(auth('owner'));
    expect(res.body).toMatchObject({ total_leads: 2, fechamentos: 1, receita_gerada: 300, precisam_de_voce: 2 });
  });
  it('tenant closer is scoped to their portfolio', async () => {
    const res = await request(await app('true')).get('/dashboard').set(auth('a', ORG1));
    expect(res.body).toMatchObject({ total_leads: 1, receita_gerada: 100, precisam_de_voce: 1 });
  });
  it('tenant organization_owner sees the clinic total only', async () => {
    const res = await request(await app('true')).get('/dashboard').set(auth('oa', ORG1));
    expect(res.body).toMatchObject({ total_leads: 2, receita_gerada: 300, precisam_de_voce: 2 });
  });
  it('rejects malicious doctor_id and never returns the other tenant rows', async () => {
    const res = await request(await app('false')).get(`/dashboard?doctor_id=${D2}`).set(auth('owner'));
    expect(res.status).toBe(403);
    expect(res.body.receita_gerada).toBeUndefined();
    expect(res.body.total_leads).toBeUndefined();
  });
  it('returns zero rather than unscoped revenue when no authorized deal exists', async () => {
    db.tables.deals = db.tables.deals.filter((d) => d.lead_id !== U(101));
    const res = await request(await app('false')).get('/dashboard').set(auth('a'));
    expect(res.body.receita_gerada).toBe(0);
  });
});
