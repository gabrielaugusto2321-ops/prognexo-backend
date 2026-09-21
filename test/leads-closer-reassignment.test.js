import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test'; process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));
afterEach(() => { delete process.env.TENANT_CORE_ENABLED; vi.resetModules(); });
afterAll(() => { delete process.env.TENANT_CORE_ENABLED; vi.resetModules(); });
const U = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D1 = U(1); const D2 = U(2); const DOC = U(10); const ADMIN = U(11); const C1 = U(20); const C2 = U(21); const BAD = U(22); const INACTIVE = U(23); const OTHER = U(24); const TENANT_ONLY = U(25); const LEAD = U(30); const ORG = U(40); const ORG2 = U(41); const UNIT = U(42);
const hdr = (t, org) => ({ Authorization: `Bearer ${t}`, ...(org ? { 'X-Organization-Id': org } : {}) });
async function app(flag) { vi.resetModules(); process.env.TENANT_CORE_ENABLED = flag; return (await import('../src/server.js')).createApp(); }
function seed() {
  db = makeDb({ users: [
    { id: DOC, role: 'doctor', ativo: true }, { id: ADMIN, role: 'admin', ativo: true }, { id: C1, role: 'closer', ativo: true }, { id: C2, role: 'closer', ativo: true }, { id: BAD, role: 'doctor', ativo: true }, { id: INACTIVE, role: 'closer', ativo: false }, { id: OTHER, role: 'closer', ativo: true }, { id: TENANT_ONLY, role: 'doctor', ativo: true },
  ], doctors: [{ id: D1, owner_user_id: DOC }, { id: D2, owner_user_id: BAD }], user_doctor_access: [{ user_id: C1, doctor_id: D1 }, { user_id: C2, doctor_id: D1 }, { user_id: INACTIVE, doctor_id: D1 }, { user_id: OTHER, doctor_id: D2 }],
  organizations: [{ id: ORG }, { id: ORG2 }], units: [{ id: UNIT, organization_id: ORG }], organization_doctor_map: [{ organization_id: ORG, doctor_id: D1, default_unit_id: UNIT }, { organization_id: ORG2, doctor_id: D2 }], platform_admins: [{ user_id: ADMIN }],
  memberships: [{ id: 'owner', organization_id: ORG, user_id: DOC, role: 'organization_owner', status: 'active' }, { id: 'admin', organization_id: ORG, user_id: BAD, role: 'organization_admin', status: 'active' }, { id: 'c1', organization_id: ORG, user_id: C1, role: 'closer', status: 'active' }, { id: 'c2', organization_id: ORG, user_id: C2, role: 'closer', status: 'active' }, { id: 'tenantOnly', organization_id: ORG, user_id: TENANT_ONLY, role: 'closer', status: 'active' }, { id: 'other', organization_id: ORG2, user_id: OTHER, role: 'closer', status: 'active' }], membership_units: [],
  leads: [{ id: LEAD, doctor_id: D1, organization_id: ORG, sdr_responsavel_id: C1, status_atual: 'lead' }], deals: [{ id: U(50), lead_id: LEAD, sdr_responsavel_id: C1 }, { id: U(51), lead_id: LEAD, product_id: U(60), sdr_responsavel_id: C1 }] });
  for (const [t, id] of [['doc', DOC], ['admin', ADMIN], ['c1', C1], ['orgadmin', BAD]]) db.setAuthUser(t, { id });
}
function expectSynced(value) { expect(db.tables.leads[0].sdr_responsavel_id).toBe(value); expect(db.tables.deals.every((d) => d.sdr_responsavel_id === value)).toBe(true); }

describe('PATCH /leads/:id closer reassignment', () => {
  beforeEach(seed);
  it('legacy closer cannot reassign', async () => { expect((await request(await app('false')).patch(`/leads/${LEAD}`).set(hdr('c1')).send({ sdr_responsavel_id: C2 })).status).toBe(403); expectSynced(C1); });
  it.each(['closer', 'receptionist', 'professional', 'financial', 'viewer', 'manager'])('tenant %s cannot reassign', async (role) => {
    db.tables.memberships.find((m) => m.user_id === C1).role = role;
    const res = await request(await app('true')).patch(`/leads/${LEAD}`).set(hdr('c1', ORG)).send({ sdr_responsavel_id: C2 });
    expect(res.status).toBe(403); expectSynced(C1);
  });
  it('legacy doctor assigns and unassigns across every deal', async () => {
    const api = await app('false');
    expect((await request(api).patch(`/leads/${LEAD}`).set(hdr('doc')).send({ sdr_responsavel_id: C2 })).status).toBe(200); expectSynced(C2);
    expect((await request(api).patch(`/leads/${LEAD}`).set(hdr('doc')).send({ sdr_responsavel_id: null })).status).toBe(200); expectSynced(null);
  });
  it.each([['doc', 'organization_owner'], ['orgadmin', 'organization_admin'], ['admin', 'platform_admin']])('tenant %s assigns and unassigns', async (token) => {
    const api = await app('true');
    expect((await request(api).patch(`/leads/${LEAD}`).set(hdr(token, ORG)).send({ sdr_responsavel_id: C2 })).status).toBe(200); expectSynced(C2);
    expect((await request(api).patch(`/leads/${LEAD}`).set(hdr(token, ORG)).send({ sdr_responsavel_id: null })).status).toBe(200); expectSynced(null);
  });
  it('tenant assignment accepts an active closer membership without a legacy bridge row', async () => {
    const res = await request(await app('true')).patch(`/leads/${LEAD}`).set(hdr('doc', ORG)).send({ sdr_responsavel_id: TENANT_ONLY });
    expect(res.status).toBe(200); expectSynced(TENANT_ONLY);
  });
  it.each([[OTHER, 'different tenant'], [INACTIVE, 'inactive'], [BAD, 'non-closer']])('rejects %s target (%s) without changes', async (target) => {
    const res = await request(await app('false')).patch(`/leads/${LEAD}`).set(hdr('doc')).send({ sdr_responsavel_id: target });
    expect(res.status).toBe(400); expect(res.body.error).toBe('invalid_closer'); expectSynced(C1);
  });
  it('RPC failure leaves lead and all deals unchanged', async () => {
    db.client.rpc.mockImplementationOnce(async () => ({ data: null, error: { message: 'simulated rpc failure' } }));
    const res = await request(await app('false')).patch(`/leads/${LEAD}`).set(hdr('doc')).send({ sdr_responsavel_id: C2 });
    expect(res.status).toBe(500); expectSynced(C1);
  });
  it.each([
    { sdr_responsavel_id: 'C2', status_atual: 'conversa_iniciada' },
    { sdr_responsavel_id: 'C2', nome: 'Novo Nome' },
    { sdr_responsavel_id: 'C2', telefone: '5511999999999' },
  ])('payload misto (sdr_responsavel_id + outro campo) -> 400 assignment_must_be_separate, sem alterar nada', async (payloadTemplate) => {
    const payload = { ...payloadTemplate, sdr_responsavel_id: C2 };
    const statusAntes = db.tables.leads[0].status_atual;
    const nomeAntes = db.tables.leads[0].nome;
    const res = await request(await app('false')).patch(`/leads/${LEAD}`).set(hdr('doc')).send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('assignment_must_be_separate');
    expectSynced(C1);
    expect(db.tables.leads[0].status_atual).toBe(statusAntes);
    expect(db.tables.leads[0].nome).toBe(nomeAntes);
    expect(db.client.rpc).not.toHaveBeenCalled();
  });
  it('atribuição isolada (só sdr_responsavel_id) continua funcionando após a guarda de payload misto', async () => {
    const res = await request(await app('false')).patch(`/leads/${LEAD}`).set(hdr('doc')).send({ sdr_responsavel_id: C2 });
    expect(res.status).toBe(200); expectSynced(C2);
  });
  it('atualização isolada (sem sdr_responsavel_id) continua funcionando após a guarda de payload misto', async () => {
    const res = await request(await app('false')).patch(`/leads/${LEAD}`).set(hdr('doc')).send({ status_atual: 'conversa_iniciada' });
    expect(res.status).toBe(200);
    expect(db.tables.leads[0].status_atual).toBe('conversa_iniciada');
    expectSynced(C1);
  });
});
