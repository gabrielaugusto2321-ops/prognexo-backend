import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// FASE 2.9 — platform_admin NUNCA opera "global" numa rota tenant-scoped.
//  - sem organização selecionada -> 409 organization_selection_required
//  - organização selecionada -> limitado ÀQUELA organização
//  - organização sem organization_doctor_map -> 409 tenant_backfill_required
//  - acesso global só em endpoint explicitamente global (POST /doctors,
//    GET /tenant/shadow-metrics)

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));

const U = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const PADMIN = U(1);   // linha em platform_admins, role 'closer'
const ADMIN_LEGACY = U(2); // role 'admin' (platform_admin legado)
const CLOSER = U(3);
const ORG_A = U('a');
const ORG_B = U('b');
const ORG_C = U('c'); // sem organization_doctor_map
const DOC_A = U('d');
const DOC_B = U('e');

function seed() {
  db = makeDb({
    users: [
      { id: PADMIN, role: 'closer', ativo: true },
      { id: ADMIN_LEGACY, role: 'admin', ativo: true },
      { id: CLOSER, role: 'closer', ativo: true },
    ],
    doctors: [
      { id: DOC_A, owner_user_id: U(7) },
      { id: DOC_B, owner_user_id: U(8) },
    ],
    organizations: [
      { id: ORG_A, name: 'A', status: 'active' },
      { id: ORG_B, name: 'B', status: 'active' },
      { id: ORG_C, name: 'C', status: 'active' },
    ],
    units: [{ id: 'uA', organization_id: ORG_A, name: 'UA', status: 'active' }],
    memberships: [
      { id: 'mCloser', organization_id: ORG_A, user_id: CLOSER, role: 'closer', status: 'active' },
    ],
    membership_units: [{ membership_id: 'mCloser', unit_id: 'uA' }],
    platform_admins: [{ user_id: PADMIN }],
    organization_doctor_map: [
      { organization_id: ORG_A, doctor_id: DOC_A, default_unit_id: 'uA' },
      { organization_id: ORG_B, doctor_id: DOC_B, default_unit_id: null },
      // ORG_C: SEM linha -> backfill gap
    ],
    user_doctor_access: [],
    leads: [
      { id: 'lA', doctor_id: DOC_A, organization_id: ORG_A, status_atual: 'lead', criado_em: new Date().toISOString() },
      { id: 'lB', doctor_id: DOC_B, organization_id: ORG_B, status_atual: 'lead', criado_em: new Date().toISOString() },
    ],
  });
  db.setAuthUser('padmin', { id: PADMIN });
  db.setAuthUser('adminLegacy', { id: ADMIN_LEGACY });
  db.setAuthUser('closer', { id: CLOSER });
}

const KEY = Buffer.alloc(32, 7).toString('base64');
async function app(tenantCore) {
  vi.resetModules();
  process.env.TENANT_CORE_ENABLED = tenantCore;
  delete process.env.TENANT_SHADOW_READ_ENABLED;
  const mod = await import('../src/server.js');
  return mod.createApp();
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('FASE 2.9 — platform_admin em rota tenant-scoped (flag ON)', () => {
  beforeEach(seed);

  it('sem X-Organization-Id -> 409 organization_selection_required (padmin table)', async () => {
    const res = await request(await app('true')).get('/leads').set(bearer('padmin'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('organization_selection_required');
  });

  it('sem X-Organization-Id -> 409 (admin legado role=admin)', async () => {
    const res = await request(await app('true')).get('/leads').set(bearer('adminLegacy'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('organization_selection_required');
  });

  it('com X-Organization-Id=ORG_A -> 200 e limitado ao doctor da ORG_A (não vê lead da ORG_B)', async () => {
    // adminLegacy: role 'admin' (não sofre o filtro closer-own-leads)
    const res = await request(await app('true')).get('/leads').set(bearer('adminLegacy')).set('X-Organization-Id', ORG_A);
    expect(res.status).toBe(200);
    expect(res.body.map((l) => l.id)).toEqual(['lA']);
  });

  it('com X-Organization-Id=ORG_B -> vê só o lead da ORG_B', async () => {
    const res = await request(await app('true')).get('/leads').set(bearer('adminLegacy')).set('X-Organization-Id', ORG_B);
    expect(res.status).toBe(200);
    expect(res.body.map((l) => l.id)).toEqual(['lB']);
  });

  it('organização sem organization_doctor_map -> 409 tenant_backfill_required (nunca "vê tudo")', async () => {
    const res = await request(await app('true')).get('/leads').set(bearer('padmin')).set('X-Organization-Id', ORG_C);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tenant_backfill_required');
  });

  it('PATCH /leads de lead da ORG_B com ORG_A selecionada -> 403/404 (sem cross-org mesmo sendo admin)', async () => {
    const res = await request(await app('true'))
      .patch('/leads/lB').set(bearer('padmin')).set('X-Organization-Id', ORG_A)
      .send({ status_atual: 'perdido' });
    expect([403, 404]).toContain(res.status);
  });

  it('GET /doctors sem seleção -> 409; com ORG_A -> só DOC_A', async () => {
    const r1 = await request(await app('true')).get('/doctors').set(bearer('padmin'));
    expect(r1.status).toBe(409);
    const r2 = await request(await app('true')).get('/doctors').set(bearer('padmin')).set('X-Organization-Id', ORG_A);
    expect(r2.status).toBe(200);
    expect(r2.body.map((d) => d.id)).toEqual([DOC_A]);
  });
});

describe('FASE 2.9 — endpoints EXPLICITAMENTE globais', () => {
  beforeEach(seed);

  it('POST /doctors: platform_admin sem organização selecionada -> 201 (global)', async () => {
    const res = await request(await app('true'))
      .post('/doctors').set(bearer('padmin'))
      .send({ nome: 'Nova Clínica', owner_user_id: U(9) });
    expect(res.status).toBe(201);
  });

  it('POST /doctors: não-admin -> 403', async () => {
    const res = await request(await app('true'))
      .post('/doctors').set(bearer('closer'))
      .send({ nome: 'X', owner_user_id: U(9) });
    expect(res.status).toBe(403);
  });

  it('GET /tenant/shadow-metrics: platform_admin sem org -> 200; não-admin -> 403', async () => {
    const a = await app('true');
    const ok = await request(a).get('/tenant/shadow-metrics').set(bearer('padmin'));
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('comparisons');
    const no = await request(a).get('/tenant/shadow-metrics').set(bearer('closer'));
    expect(no.status).toBe(403);
  });
});

describe('FASE 2.9 — flag OFF: admin legado inalterado', () => {
  beforeEach(seed);

  it('role=admin vê todos os leads (getScopedDoctorIds legado = null)', async () => {
    const res = await request(await app('false')).get('/leads').set(bearer('adminLegacy'));
    expect(res.status).toBe(200);
    expect(res.body.map((l) => l.id).sort()).toEqual(['lA', 'lB']);
  });

  it('role=admin vê todos os doctors', async () => {
    const res = await request(await app('false')).get('/doctors').set(bearer('adminLegacy'));
    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.id).sort()).toEqual([DOC_A, DOC_B].sort());
  });
});
