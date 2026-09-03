import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// FASE 2.1 — resolvedor de contexto de tenant + feature flag TENANT_CORE_ENABLED.
// Testado através do corte vertical (/leads).

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));

const U = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const OWNER = U(1);
const MULTI = U(2);
const NOBODY = U(3);
const DOC_A = U(5);
const DOC_B = U(6);
const ORG_A = U(7);
const ORG_B = U(8);

function seed() {
  db = makeDb({
    users: [
      { id: OWNER, role: 'doctor', ativo: true },
      { id: MULTI, role: 'closer', ativo: true },
      { id: NOBODY, role: 'closer', ativo: true },
    ],
    doctors: [
      { id: DOC_A, owner_user_id: OWNER },
      { id: DOC_B, owner_user_id: U(9) },
    ],
    memberships: [
      { id: 'm1', organization_id: ORG_A, user_id: OWNER, role: 'organization_owner', status: 'active' },
      { id: 'm2', organization_id: ORG_A, user_id: MULTI, role: 'closer', status: 'active' },
      { id: 'm3', organization_id: ORG_B, user_id: MULTI, role: 'closer', status: 'active' },
    ],
    platform_admins: [],
    organization_doctor_map: [
      { organization_id: ORG_A, doctor_id: DOC_A, default_unit_id: 'unitA' },
      { organization_id: ORG_B, doctor_id: DOC_B, default_unit_id: 'unitB' },
    ],
    leads: [
      { id: 'lA', doctor_id: DOC_A, organization_id: ORG_A, status_atual: 'lead', sdr_responsavel_id: MULTI, criado_em: new Date().toISOString() },
      { id: 'lB', doctor_id: DOC_B, organization_id: ORG_B, status_atual: 'lead', criado_em: new Date().toISOString() },
    ],
    conversations: [],
  });
  db.setAuthUser('owner', { id: OWNER });
  db.setAuthUser('multi', { id: MULTI });
  db.setAuthUser('nobody', { id: NOBODY });
}

async function importAppWithFlag(flag) {
  vi.resetModules();
  process.env.TENANT_CORE_ENABLED = flag;
  const mod = await import('../src/server.js');
  return mod.createApp();
}

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('tenant context resolver + feature flag', () => {
  beforeEach(seed);

  it('flag=false: comportamento atual — GET /leads escopa pelo caminho legado (doctor_id)', async () => {
    const app = await importAppWithFlag('false');
    const res = await request(app).get('/leads').set(bearer('owner'));
    expect(res.status).toBe(200);
    // doctor OWNER via getScopedDoctorIds -> só doctor A -> só lead lA
    expect(res.body.map((l) => l.id)).toEqual(['lA']);
  });

  it('flag=true: GET /leads usa a organização derivada da membership única', async () => {
    const app = await importAppWithFlag('true');
    const res = await request(app).get('/leads').set(bearer('owner'));
    expect(res.status).toBe(200);
    expect(res.body.map((l) => l.id)).toEqual(['lA']);
  });

  it('flag=true: usuário com 2 organizações SEM header -> 409 organization_selection_required', async () => {
    const app = await importAppWithFlag('true');
    const res = await request(app).get('/leads').set(bearer('multi'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('organization_selection_required');
  });

  it('flag=true: MULTI seleciona Org A via header -> vê lead da Org A', async () => {
    const app = await importAppWithFlag('true');
    const res = await request(app).get('/leads').set(bearer('multi')).set('X-Organization-Id', ORG_A);
    expect(res.status).toBe(200);
    expect(res.body.map((l) => l.id)).toEqual(['lA']);
  });

  it('flag=true: MULTI tenta selecionar organização SEM membership -> 403 no_membership_for_org', async () => {
    const app = await importAppWithFlag('true');
    const res = await request(app).get('/leads').set(bearer('multi')).set('X-Organization-Id', U('a'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_membership_for_org');
  });

  it('flag=true: usuário sem nenhuma membership -> 403 no_active_membership', async () => {
    const app = await importAppWithFlag('true');
    const res = await request(app).get('/leads').set(bearer('nobody'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_active_membership');
  });

  it('flag=true: organization_id no BODY é ignorado (não vira fonte de autoridade)', async () => {
    const app = await importAppWithFlag('true');
    // OWNER só é membro da Org A; manda organization_id da Org B no body
    const res = await request(app)
      .post('/leads')
      .set(bearer('owner'))
      .send({ doctor_id: DOC_A, nome: 'X', organization_id: ORG_B });
    // body.organization_id não está no schema (.strict) -> 400 invalid_payload
    expect(res.status).toBe(400);
  });

  it('flag=true: POST /leads grava organization_id da membership (não do body) e exige doctor_id coerente', async () => {
    const app = await importAppWithFlag('true');
    const ok = await request(app).post('/leads').set(bearer('owner')).send({ doctor_id: DOC_A, nome: 'Novo' });
    expect(ok.status).toBe(201);
    const created = db.tables.leads.find((l) => l.nome === 'Novo');
    expect(created.organization_id).toBe(ORG_A);

    // doctor_id da Org B com contexto da Org A -> 403 doctor_org_mismatch
    const bad = await request(app).post('/leads').set(bearer('owner')).send({ doctor_id: DOC_B, nome: 'Bad' });
    expect(bad.status).toBe(403);
    // barrado antes de gravar — pelo escopo legado ('forbidden') ou pelo check de tenant
    expect(['forbidden', 'doctor_org_mismatch']).toContain(bad.body.error);
  });
});
