import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// Higiene de estado global: este arquivo alterna TENANT_CORE_ENABLED via
// makeApp() + vi.resetModules(). O baseline da suíte é a flag AUSENTE
// (== desligada), então limpamos entre cada teste e ao final, deixando o
// processo no estado pristino para os próximos arquivos.
afterEach(() => {
  delete process.env.TENANT_CORE_ENABLED;
  vi.resetModules();
});
afterAll(() => {
  delete process.env.TENANT_CORE_ENABLED;
  vi.resetModules();
});

// FASE 3.3A — PATCH /leads/:id/ai-feedback (avaliação humana da Auditoria de IA).
// Feedback da IA é AÇÃO EXCLUSIVA DE GESTÃO: closer nunca avalia, nem seu
// próprio lead. Testes de contrato HTTP: papel, escopo de recurso, schema
// estrito, autor/timestamp server-side, idempotência, resposta mínima.
// A prova de RLS/grants é feita contra Postgres real em
// test/rls/ai-feedback.rls.test.js — este mock não a substitui.

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));

const U = (s) => `00000000-0000-4000-8000-0000000000${s}`;
const DOCTOR = U('01'); const DOCTOR2 = U('02');
const DOC_OWNER = U('11'); const DOC_OWNER2 = U('12');
const CLOSER = U('21'); const CLOSER_OUTRO = U('22');
const ADMIN = U('31');
const LEAD = U('a1'); const LEAD2 = U('a2'); const LEAD_OUTRO_DOC = U('b1');

const as = (t) => ({ Authorization: `Bearer ${t}` });
const RESP_KEYS = ['id', 'feedback_ia', 'feedback_ia_at', 'feedback_ia_by'].sort();

async function makeApp(flag) {
  vi.resetModules();
  process.env.TENANT_CORE_ENABLED = flag;
  const mod = await import('../src/server.js');
  return mod.createApp();
}

// ---------------------------------------------------------------------------
// Modo legado (TENANT_CORE_ENABLED=false) — só users.role admin|doctor
// ---------------------------------------------------------------------------
describe('PATCH /leads/:id/ai-feedback — modo legado', () => {
  beforeEach(() => {
    db = makeDb({
      users: [
        { id: DOC_OWNER, role: 'doctor', ativo: true },
        { id: DOC_OWNER2, role: 'doctor', ativo: true },
        { id: CLOSER, role: 'closer', ativo: true },
        { id: CLOSER_OUTRO, role: 'closer', ativo: true },
        { id: ADMIN, role: 'admin', ativo: true },
      ],
      doctors: [
        { id: DOCTOR, owner_user_id: DOC_OWNER },
        { id: DOCTOR2, owner_user_id: DOC_OWNER2 },
      ],
      user_doctor_access: [
        // CLOSER tem acesso legado ao DOCTOR e é responsável pelo LEAD —
        // ainda assim NÃO pode avaliar a IA.
        { user_id: CLOSER, doctor_id: DOCTOR },
        { user_id: CLOSER_OUTRO, doctor_id: DOCTOR },
      ],
      leads: [
        { id: LEAD, doctor_id: DOCTOR, nome: 'Lead 1', sdr_responsavel_id: CLOSER, status_atual: 'reuniao_marcada', ia_motivo_handoff: 'score', feedback_ia: null, criado_em: new Date().toISOString() },
        { id: LEAD2, doctor_id: DOCTOR, nome: 'Lead 2', sdr_responsavel_id: null, status_atual: 'lead', ia_motivo_handoff: 'limite_mensagens', feedback_ia: null, criado_em: new Date().toISOString() },
        { id: LEAD_OUTRO_DOC, doctor_id: DOCTOR2, nome: 'Lead B', sdr_responsavel_id: null, status_atual: 'lead', ia_motivo_handoff: 'score', feedback_ia: null, criado_em: new Date().toISOString() },
      ],
    });
    db.setAuthUser('owner', { id: DOC_OWNER });
    db.setAuthUser('owner2', { id: DOC_OWNER2 });
    db.setAuthUser('closer', { id: CLOSER });
    db.setAuthUser('closerOutro', { id: CLOSER_OUTRO });
    db.setAuthUser('admin', { id: ADMIN });
  });

  it('doctor legado dentro do próprio escopo: avalia "bom" — persiste, autor = JWT, resposta mínima', async () => {
    const app = await makeApp('false');
    const res = await request(app).patch(`/leads/${LEAD2}/ai-feedback`).set(as('owner')).send({ feedback: 'bom' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(RESP_KEYS);
    expect(res.body.feedback_ia).toBe('bom');
    expect(res.body.feedback_ia_by).toBe(DOC_OWNER);
    expect(typeof res.body.feedback_ia_at).toBe('string');
    expect(db.tables.leads.find((l) => l.id === LEAD2).feedback_ia).toBe('bom');
  });

  it('doctor legado FORA do escopo (lead de outro doctor): negado (403/404)', async () => {
    const app = await makeApp('false');
    const res = await request(app).patch(`/leads/${LEAD_OUTRO_DOC}/ai-feedback`).set(as('owner')).send({ feedback: 'bom' });
    expect([403, 404]).toContain(res.status);
    expect(db.tables.leads.find((l) => l.id === LEAD_OUTRO_DOC).feedback_ia).toBeNull();
  });

  it('avalia "ruim" e depois limpa com null (toggle)', async () => {
    const app = await makeApp('false');
    await request(app).patch(`/leads/${LEAD2}/ai-feedback`).set(as('owner')).send({ feedback: 'ruim' });
    const res = await request(app).patch(`/leads/${LEAD2}/ai-feedback`).set(as('owner')).send({ feedback: null });
    expect(res.status).toBe(200);
    expect(res.body.feedback_ia).toBeNull();
    expect(res.body.feedback_ia_at).toBeNull();
    expect(res.body.feedback_ia_by).toBeNull();
  });

  it('admin legado: avalia qualquer lead', async () => {
    const app = await makeApp('false');
    const res = await request(app).patch(`/leads/${LEAD_OUTRO_DOC}/ai-feedback`).set(as('admin')).send({ feedback: 'bom' });
    expect(res.status).toBe(200);
    expect(res.body.feedback_ia).toBe('bom');
  });

  it('CLOSER dono/responsável pelo lead: 403 — posse não autoriza avaliar a IA', async () => {
    const app = await makeApp('false');
    const res = await request(app).patch(`/leads/${LEAD}/ai-feedback`).set(as('closer')).send({ feedback: 'ruim' });
    expect(res.status).toBe(403);
    expect(db.tables.leads.find((l) => l.id === LEAD).feedback_ia).toBeNull();
  });

  it('CLOSER não dono do lead: 403', async () => {
    const app = await makeApp('false');
    const res = await request(app).patch(`/leads/${LEAD2}/ai-feedback`).set(as('closerOutro')).send({ feedback: 'bom' });
    expect(res.status).toBe(403);
  });

  it('lead inexistente: 404 sem revelar existência', async () => {
    const app = await makeApp('false');
    const res = await request(app).patch(`/leads/${U('ff')}/ai-feedback`).set(as('owner')).send({ feedback: 'bom' });
    expect(res.status).toBe(404);
  });

  it('sem autenticação: 401', async () => {
    const app = await makeApp('false');
    const res = await request(app).patch(`/leads/${LEAD2}/ai-feedback`).send({ feedback: 'bom' });
    expect(res.status).toBe(401);
  });

  it('valor de feedback inválido: 400', async () => {
    const app = await makeApp('false');
    for (const bad of ['reuniao', 'otimo', 'BOM', '', 1, true]) {
      const res = await request(app).patch(`/leads/${LEAD2}/ai-feedback`).set(as('owner')).send({ feedback: bad });
      expect(res.status, `feedback=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('campo extra no body (mass assignment / autor / timestamp): 400', async () => {
    const app = await makeApp('false');
    for (const extra of [
      { feedback: 'bom', feedback_ia_by: ADMIN },
      { feedback: 'bom', feedback_ia_at: '2020-01-01T00:00:00Z' },
      { feedback: 'bom', doctor_id: DOCTOR2 },
      { feedback: 'bom', organization_id: U('cc') },
      { feedback: 'bom', status_atual: 'fechado' },
      { feedback: 'bom', ia_score: 99 },
      { feedback: 'bom', role: 'admin' },
    ]) {
      const res = await request(app).patch(`/leads/${LEAD2}/ai-feedback`).set(as('owner')).send(extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(db.tables.leads.find((l) => l.id === LEAD2).feedback_ia).toBeNull();
  });

  it('idempotência: reavaliar com o mesmo valor mantém o timestamp', async () => {
    const app = await makeApp('false');
    const r1 = await request(app).patch(`/leads/${LEAD2}/ai-feedback`).set(as('owner')).send({ feedback: 'bom' });
    const at1 = r1.body.feedback_ia_at;
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await request(app).patch(`/leads/${LEAD2}/ai-feedback`).set(as('owner')).send({ feedback: 'bom' });
    expect(r2.status).toBe(200);
    expect(r2.body.feedback_ia_at).toBe(at1);
  });

  it('não vaza a linha inteira do lead', async () => {
    const app = await makeApp('false');
    const res = await request(app).patch(`/leads/${LEAD}/ai-feedback`).set(as('admin')).send({ feedback: 'bom' });
    expect(Object.keys(res.body).sort()).toEqual(RESP_KEYS);
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain('Lead 1');
    expect(blob).not.toContain('reuniao_marcada');
  });
});

// ---------------------------------------------------------------------------
// Modo tenant core (TENANT_CORE_ENABLED=true) — só papéis de gestão + platform_admin
// ---------------------------------------------------------------------------
describe('PATCH /leads/:id/ai-feedback — tenant core', () => {
  const ORG_A = U('aa'); const ORG_B = U('bb'); const UNIT_A = U('c1');
  const OWNER = U('41'); const ORGADMIN = U('42'); const MANAGER = U('43');
  const VIEWER = U('44'); const RECEP = U('45'); const PROF = U('46'); const FIN = U('47');
  const CLOSER_T = U('48'); const NOBODY = U('49'); const SUSPENSO = U('4a'); const PLAT = U('4b');

  const seedUser = (id) => ({ id, role: 'doctor', ativo: true });

  beforeEach(() => {
    db = makeDb({
      users: [OWNER, ORGADMIN, MANAGER, VIEWER, RECEP, PROF, FIN, NOBODY, SUSPENSO, PLAT].map(seedUser)
        .concat([{ id: CLOSER_T, role: 'closer', ativo: true }]),
      doctors: [{ id: DOCTOR, owner_user_id: OWNER }, { id: DOCTOR2, owner_user_id: DOC_OWNER2 }],
      organizations: [
        { id: ORG_A, name: 'A', status: 'active' },
        { id: ORG_B, name: 'B', status: 'active' },
      ],
      units: [{ id: UNIT_A, organization_id: ORG_A, name: 'U', status: 'active' }],
      platform_admins: [{ user_id: PLAT }],
      memberships: [
        { id: 'mOwner', organization_id: ORG_A, user_id: OWNER, role: 'organization_owner', status: 'active' },
        { id: 'mAdmin', organization_id: ORG_A, user_id: ORGADMIN, role: 'organization_admin', status: 'active' },
        { id: 'mManager', organization_id: ORG_A, user_id: MANAGER, role: 'manager', status: 'active' },
        { id: 'mViewer', organization_id: ORG_A, user_id: VIEWER, role: 'viewer', status: 'active' },
        { id: 'mRecep', organization_id: ORG_A, user_id: RECEP, role: 'receptionist', status: 'active' },
        { id: 'mProf', organization_id: ORG_A, user_id: PROF, role: 'professional', status: 'active' },
        { id: 'mFin', organization_id: ORG_A, user_id: FIN, role: 'financial', status: 'active' },
        { id: 'mCloser', organization_id: ORG_A, user_id: CLOSER_T, role: 'closer', status: 'active' },
        { id: 'mSusp', organization_id: ORG_A, user_id: SUSPENSO, role: 'manager', status: 'suspended' },
      ],
      membership_units: [
        { membership_id: 'mOwner', unit_id: UNIT_A }, { membership_id: 'mManager', unit_id: UNIT_A },
      ],
      user_doctor_access: [{ user_id: CLOSER_T, doctor_id: DOCTOR }],
      organization_doctor_map: [
        { organization_id: ORG_A, doctor_id: DOCTOR, default_unit_id: UNIT_A },
        { organization_id: ORG_B, doctor_id: DOCTOR2, default_unit_id: null },
      ],
      leads: [
        { id: LEAD, doctor_id: DOCTOR, organization_id: ORG_A, nome: 'L A', sdr_responsavel_id: CLOSER_T, status_atual: 'lead', ia_motivo_handoff: 'score', feedback_ia: null, criado_em: new Date().toISOString() },
        { id: LEAD_OUTRO_DOC, doctor_id: DOCTOR2, organization_id: ORG_B, nome: 'L B', sdr_responsavel_id: null, status_atual: 'lead', ia_motivo_handoff: 'score', feedback_ia: null, criado_em: new Date().toISOString() },
      ],
    });
    for (const [tok, id] of [['owner', OWNER], ['orgadmin', ORGADMIN], ['manager', MANAGER], ['viewer', VIEWER],
      ['recep', RECEP], ['prof', PROF], ['fin', FIN], ['closerT', CLOSER_T], ['nobody', NOBODY], ['suspenso', SUSPENSO], ['plat', PLAT]]) {
      db.setAuthUser(tok, { id });
    }
  });

  const hdr = (t, org) => ({ Authorization: `Bearer ${t}`, 'X-Organization-Id': org });

  for (const [tok, papel] of [['owner', 'organization_owner'], ['orgadmin', 'organization_admin'], ['manager', 'manager']]) {
    it(`${papel}: avalia com sucesso (autor = JWT)`, async () => {
      const app = await makeApp('true');
      const res = await request(app).patch(`/leads/${LEAD}/ai-feedback`).set(hdr(tok, ORG_A)).send({ feedback: 'bom' });
      expect(res.status).toBe(200);
      expect(res.body.feedback_ia).toBe('bom');
    });
  }

  it('platform_admin com a organização selecionada corretamente: 200 (escopado à org)', async () => {
    const app = await makeApp('true');
    const ok = await request(app).patch(`/leads/${LEAD}/ai-feedback`).set(hdr('plat', ORG_A)).send({ feedback: 'ruim' });
    expect(ok.status).toBe(200);
    // ...mas escopado: lead da Org B com Org A selecionada -> negado
    const no = await request(app).patch(`/leads/${LEAD_OUTRO_DOC}/ai-feedback`).set(hdr('plat', ORG_A)).send({ feedback: 'bom' });
    expect([403, 404]).toContain(no.status);
  });

  for (const [tok, papel] of [['viewer', 'viewer'], ['recep', 'receptionist'], ['prof', 'professional'], ['fin', 'financial']]) {
    it(`papel ${papel}: 403`, async () => {
      const app = await makeApp('true');
      const res = await request(app).patch(`/leads/${LEAD}/ai-feedback`).set(hdr(tok, ORG_A)).send({ feedback: 'bom' });
      expect(res.status).toBe(403);
      expect(db.tables.leads.find((l) => l.id === LEAD).feedback_ia).toBeNull();
    });
  }

  it('CLOSER com membership ativa E responsável pelo lead: 403', async () => {
    const app = await makeApp('true');
    const res = await request(app).patch(`/leads/${LEAD}/ai-feedback`).set(hdr('closerT', ORG_A)).send({ feedback: 'bom' });
    expect(res.status).toBe(403);
    expect(db.tables.leads.find((l) => l.id === LEAD).feedback_ia).toBeNull();
  });

  it('sem membership na org: negado', async () => {
    const app = await makeApp('true');
    const res = await request(app).patch(`/leads/${LEAD}/ai-feedback`).set(hdr('nobody', ORG_A)).send({ feedback: 'bom' });
    expect([403, 409]).toContain(res.status);
  });

  it('membership suspensa: negado', async () => {
    const app = await makeApp('true');
    const res = await request(app).patch(`/leads/${LEAD}/ai-feedback`).set(hdr('suspenso', ORG_A)).send({ feedback: 'bom' });
    expect([403, 409]).toContain(res.status);
  });

  it('manager: lead de outra organização (Org A selecionada): negado, sem revelar', async () => {
    const app = await makeApp('true');
    const res = await request(app).patch(`/leads/${LEAD_OUTRO_DOC}/ai-feedback`).set(hdr('manager', ORG_A)).send({ feedback: 'bom' });
    expect([403, 404]).toContain(res.status);
    expect(db.tables.leads.find((l) => l.id === LEAD_OUTRO_DOC).feedback_ia).toBeNull();
  });

  it('body não pode carregar organization_id/doctor_id junto: 400', async () => {
    const app = await makeApp('true');
    const res = await request(app).patch(`/leads/${LEAD}/ai-feedback`).set(hdr('manager', ORG_A))
      .send({ feedback: 'bom', organization_id: ORG_B, doctor_id: DOCTOR2 });
    expect(res.status).toBe(400);
  });
});
