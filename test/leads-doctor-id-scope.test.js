// GET /leads?doctor_id= — o doctor_id da query string precisa ser validado
// explicitamente contra o escopo autorizado do chamador (tenantAllowsDoctor),
// respondendo 403 quando fora do escopo. O .in(scopedIds) combinado com
// .eq(doctor_id) já impedia AMPLIAR o acesso (um doctor_id fora do escopo
// nunca batia nenhuma linha), mas devolvia 200 com lista vazia em vez de um
// erro explícito — este arquivo prova a resposta 403 correta, em modo legado
// (closer/doctor) e em modo tenant.
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
afterEach(() => { delete process.env.TENANT_CORE_ENABLED; vi.resetModules(); });
afterAll(() => { delete process.env.TENANT_CORE_ENABLED; vi.resetModules(); });

const U = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DOC = U(1); const CLOSER = U(2); const D1 = U(10); const D2 = U(11);
const ORG = U(20); const UNIT = U(21);
const hdr = (t, org) => ({ Authorization: `Bearer ${t}`, ...(org ? { 'X-Organization-Id': org } : {}) });
async function app(flag) { vi.resetModules(); process.env.TENANT_CORE_ENABLED = flag; return (await import('../src/server.js')).createApp(); }

function seed() {
  db = makeDb({
    users: [
      { id: DOC, role: 'doctor', ativo: true },
      { id: CLOSER, role: 'closer', ativo: true },
    ],
    doctors: [{ id: D1, owner_user_id: DOC }, { id: D2, owner_user_id: U(99) }],
    user_doctor_access: [{ user_id: CLOSER, doctor_id: D1 }],
    organizations: [{ id: ORG }],
    units: [{ id: UNIT, organization_id: ORG }],
    organization_doctor_map: [{ organization_id: ORG, doctor_id: D1, default_unit_id: UNIT }],
    memberships: [{ id: 'owner', organization_id: ORG, user_id: DOC, role: 'organization_owner', status: 'active' }],
    leads: [
      { id: U(30), doctor_id: D1, nome: 'Lead D1' },
      { id: U(31), doctor_id: D2, nome: 'Lead D2 (outro tenant)' },
    ],
  });
  db.setAuthUser('doc', { id: DOC });
  db.setAuthUser('closer', { id: CLOSER });
}

describe('GET /leads?doctor_id= (escopo)', () => {
  beforeEach(seed);

  it('doctor_id autorizado (legado, doctor dono) -> 200 com os leads do doctor', async () => {
    const res = await request(await app('false')).get('/leads').query({ doctor_id: D1 }).set(hdr('doc'));
    expect(res.status).toBe(200);
    expect(res.body.every((l) => l.doctor_id === D1)).toBe(true);
  });

  it('doctor_id fora do escopo (legado, doctor não é dono) -> 403 doctor_out_of_scope', async () => {
    const res = await request(await app('false')).get('/leads').query({ doctor_id: D2 }).set(hdr('doc'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('doctor_out_of_scope');
  });

  it('closer: doctor_id do próprio escopo -> 200', async () => {
    const res = await request(await app('false')).get('/leads').query({ doctor_id: D1 }).set(hdr('closer'));
    expect(res.status).toBe(200);
  });

  it('closer: doctor_id fora do escopo -> 403 doctor_out_of_scope', async () => {
    const res = await request(await app('false')).get('/leads').query({ doctor_id: D2 }).set(hdr('closer'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('doctor_out_of_scope');
  });

  it('tenant-mode: doctor_id da organização selecionada -> 200', async () => {
    const res = await request(await app('true')).get('/leads').query({ doctor_id: D1 }).set(hdr('doc', ORG));
    expect(res.status).toBe(200);
  });

  it('tenant-mode: doctor_id de fora da organização selecionada -> 403 doctor_out_of_scope', async () => {
    const res = await request(await app('true')).get('/leads').query({ doctor_id: D2 }).set(hdr('doc', ORG));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('doctor_out_of_scope');
  });

  it('sem doctor_id: continua respeitando o escopo (200), sem exigir o parâmetro', async () => {
    const res = await request(await app('false')).get('/leads').set(hdr('doc'));
    expect(res.status).toBe(200);
    expect(res.body.every((l) => l.doctor_id === D1)).toBe(true);
  });
});
