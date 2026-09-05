import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// FASE 2.6 — contrato HTTP de /team sob TEAM_MEMBERSHIPS_ENABLED.
// A correção de segurança de verdade (RLS/RPC reais) está em
// test/rls/team-memberships.rls.test.js — aqui só o contrato da rota.

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));

const U = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const OWNER_A = U(1);
const ADMIN_A = U(2);
const CLOSER_A = U(3);
const OWNER_B = U(4);
const VIEWER_A = U(5);
const NEW_USER = U(6);
const ADMIN2_A = U(7);
const ORG_A = U('a');
const ORG_B = U('b');
const DOC_A = U('d');
const UNIT_A1 = '00000000-0000-4000-8000-0000000a0001';
const UNIT_B1 = '00000000-0000-4000-8000-0000000b0001';

function seed(extra = {}) {
  db = makeDb({
    users: [
      { id: OWNER_A, nome: 'Owner A', email: 'owner-a@x.com', role: 'doctor', ativo: true },
      { id: ADMIN_A, nome: 'Admin A', email: 'admin-a@x.com', role: 'closer', ativo: true },
      { id: CLOSER_A, nome: 'Closer A', email: 'closer-a@x.com', role: 'closer', ativo: true },
      { id: OWNER_B, nome: 'Owner B', email: 'owner-b@x.com', role: 'doctor', ativo: true },
      { id: VIEWER_A, nome: 'Viewer A', email: 'viewer-a@x.com', role: 'closer', ativo: true },
      { id: ADMIN2_A, nome: 'Admin2 A', email: 'admin2-a@x.com', role: 'closer', ativo: true },
    ],
    doctors: [{ id: DOC_A, owner_user_id: OWNER_A, distribuicao_automatica: false }],
    organizations: [{ id: ORG_A, name: 'A', status: 'active' }, { id: ORG_B, name: 'B', status: 'active' }],
    units: [{ id: UNIT_A1, organization_id: ORG_A, name: 'Unidade A1' }, { id: UNIT_B1, organization_id: ORG_B, name: 'Unidade B1' }],
    organization_doctor_map: [{ organization_id: ORG_A, doctor_id: DOC_A }],
    memberships: [
      { organization_id: ORG_A, user_id: OWNER_A, role: 'organization_owner', status: 'active' },
      { organization_id: ORG_A, user_id: ADMIN_A, role: 'organization_admin', status: 'active' },
      { organization_id: ORG_A, user_id: CLOSER_A, role: 'closer', status: 'active' },
      { organization_id: ORG_A, user_id: VIEWER_A, role: 'viewer', status: 'active' },
      { organization_id: ORG_A, user_id: ADMIN2_A, role: 'organization_admin', status: 'active' },
      { organization_id: ORG_B, user_id: OWNER_B, role: 'organization_owner', status: 'active' },
    ],
    membership_units: [],
    user_doctor_access: [{ user_id: CLOSER_A, doctor_id: DOC_A }],
    platform_admins: [],
    team_membership_events: [],
    ...extra,
  });
  db.setAuthUser('ownerA', { id: OWNER_A });
  db.setAuthUser('adminA', { id: ADMIN_A });
  db.setAuthUser('closerA', { id: CLOSER_A });
  db.setAuthUser('viewerA', { id: VIEWER_A });
  db.setAuthUser('ownerB', { id: OWNER_B });
  db.setAuthUser('admin2A', { id: ADMIN2_A });
}

async function app(tenantFlag, teamFlag) {
  vi.resetModules();
  process.env.TENANT_CORE_ENABLED = tenantFlag;
  process.env.TEAM_MEMBERSHIPS_ENABLED = teamFlag;
  const mod = await import('../src/server.js');
  return mod.createApp();
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const org = (id) => ({ 'X-Organization-Id': id });

describe('POST/PATCH/DELETE /team — flag ligada (TEAM_MEMBERSHIPS_ENABLED=true)', () => {
  beforeEach(() => seed());

  it('GET /team lista memberships da organização com papel/status/unidades', async () => {
    const a = await app('true', 'true');
    const res = await request(a).get('/team').set(bearer('ownerA')).set(org(ORG_A));
    expect(res.status).toBe(200);
    const nomes = res.body.membros.map((m) => m.nome).sort();
    expect(nomes).toEqual(['Admin A', 'Admin2 A', 'Closer A', 'Owner A', 'Viewer A'].sort());
    const closer = res.body.membros.find((m) => m.id === CLOSER_A);
    expect(closer.role).toBe('closer');
    expect(closer.status).toBe('active');
  });

  it('closer/viewer não podem GET (só owner/admin/platform_admin gerenciam)', async () => {
    const a = await app('true', 'true');
    expect((await request(a).get('/team').set(bearer('closerA')).set(org(ORG_A))).status).toBe(403);
    expect((await request(a).get('/team').set(bearer('viewerA')).set(org(ORG_A))).status).toBe(403);
  });

  // FASE 2.7 — BLOQUEADOR DE SEGURANÇA (revisão pós-entrega): com
  // TEAM_MEMBERSHIPS_ENABLED=true, POST /team NUNCA MAIS cria membership nem
  // chama inviteUserByEmail — a única porta de convite passou a ser
  // POST /team/invitations (outbox persistente, ver test/team-invitations-api.test.js
  // pra hierarquia/conta-órfã/idempotência desse fluxo novo). Os testes
  // abaixo substituem os que antes verificavam a criação bem-sucedida por
  // aqui — esse caminho foi removido de propósito, não é uma regressão.
  it('owner tentando adicionar membro com papel novo (ex.: financial) -> 400, endpoint bloqueado, nada criado', async () => {
    const a = await app('true', 'true');
    const spy = vi.spyOn(db.client.auth.admin, 'inviteUserByEmail');
    const res = await request(a).post('/team').set(bearer('ownerA')).set(org(ORG_A))
      .send({ nome: 'Novo Financeiro', email: 'fin@x.com', role: 'financial' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('use_team_invitations_endpoint');
    expect(spy).not.toHaveBeenCalled();
    expect(db.tables.users.some((u) => u.email === 'fin@x.com')).toBe(false);
  });

  it('owner tentando adicionar membro com papel closer -> 400, endpoint bloqueado, sem criar ponte user_doctor_access', async () => {
    const a = await app('true', 'true');
    const antes = db.tables.user_doctor_access.length;
    const res = await request(a).post('/team').set(bearer('ownerA')).set(org(ORG_A))
      .send({ nome: 'Novo Closer', email: 'closer2@x.com', role: 'closer' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('use_team_invitations_endpoint');
    expect(db.tables.user_doctor_access.length).toBe(antes); // nada novo foi criado
  });

  it('bloqueio vale pra QUALQUER papel/corpo — admin tentando escalonar (owner/admin/platform_admin) também é 400, nunca chega a 403 da RPC', async () => {
    const a = await app('true', 'true');
    const spy = vi.spyOn(db.client.auth.admin, 'inviteUserByEmail');
    for (const role of ['organization_owner', 'organization_admin', 'platform_admin', 'viewer']) {
      const res = await request(a).post('/team').set(bearer('adminA')).set(org(ORG_A))
        .send({ nome: 'X', email: `x-${role}@x.com`, role });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('use_team_invitations_endpoint');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('bloqueio independe do corpo enviado (body vazio, corpo malformado, doctor_id legado misturado) — sempre 400 antes de qualquer validação de schema', async () => {
    const a = await app('true', 'true');
    for (const body of [{}, { doctor_id: DOC_A, nome: 'X', email: 'y@x.com' }, { role: 'viewer' }]) {
      const res = await request(a).post('/team').set(bearer('ownerA')).set(org(ORG_A)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('use_team_invitations_endpoint');
    }
  });

  it('CONTA ÓRFÃ deixou de ser possível por ESTE caminho: nenhum Auth user é criado, então não há o que limpar nem o que ficar órfão', async () => {
    const a = await app('true', 'true');
    const email = 'nao-cria-mais@x.com';
    const res = await request(a).post('/team').set(bearer('adminA')).set(org(ORG_A))
      .send({ nome: 'Tentativa', email, role: 'organization_owner' });
    expect(res.status).toBe(400);
    expect(db.tables.users.some((u) => u.email === email)).toBe(false);
    expect(db.client.auth.admin.deleteUser).not.toHaveBeenCalled(); // nem chega a precisar tentar limpar
  });

  it('CONTA ÓRFÃ — usuário sem NENHUMA membership (ativo=true) NÃO acessa nenhum tenant (403 no_active_membership)', async () => {
    const ORFAO_ID = U(8);
    seed({
      users: [
        { id: OWNER_A, nome: 'Owner A', email: 'owner-a@x.com', role: 'doctor', ativo: true },
        { id: ORFAO_ID, nome: 'Orfao', email: 'orfao-real@x.com', role: 'closer', ativo: true }, // como o insert de POST /team faz
      ],
      memberships: [{ organization_id: ORG_A, user_id: OWNER_A, role: 'organization_owner', status: 'active' }],
    });
    db.setAuthUser('orfaoReal', { id: ORFAO_ID });
    const a = await app('true', 'true');
    // GET /team é uma rota tenant-scoped (attachTenantContext roda ANTES de
    // qualquer checagem de papel) — sem membership nenhuma, nem chega a
    // avaliar se é manager: já barra na resolução de tenant.
    const res = await request(a).get('/team').set(bearer('orfaoReal'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_active_membership');
  });

  it('alterar papel: owner rebaixa admin para manager -> 200', async () => {
    const a = await app('true', 'true');
    const res = await request(a).patch(`/team/${ADMIN_A}/role`).set(bearer('ownerA')).set(org(ORG_A)).send({ role: 'manager' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('manager');
  });

  it('admin NÃO promove a si mesmo a owner -> 403', async () => {
    const a = await app('true', 'true');
    const res = await request(a).patch(`/team/${ADMIN_A}/role`).set(bearer('adminA')).set(org(ORG_A)).send({ role: 'organization_owner' });
    expect(res.status).toBe(403);
  });

  // ---- Bloqueador 1: hierarquia estrita admin-vs-admin (API HTTP) ----
  it('admin NÃO altera papel de OUTRO admin (403, sem alterar nada)', async () => {
    const a = await app('true', 'true');
    const res = await request(a).patch(`/team/${ADMIN2_A}/role`).set(bearer('adminA')).set(org(ORG_A)).send({ role: 'closer' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' }); // seguro: sem detalhe do alvo
    expect(db.tables.memberships.find((m) => m.user_id === ADMIN2_A).role).toBe('organization_admin');
  });

  it('admin NÃO suspende/reativa/remove/muda unidade de OUTRO admin -> 403 em todos, nada muda', async () => {
    const a = await app('true', 'true');
    const before = { ...db.tables.memberships.find((m) => m.user_id === ADMIN2_A) };
    const r1 = await request(a).patch(`/team/${ADMIN2_A}/status`).set(bearer('adminA')).set(org(ORG_A)).send({ status: 'suspended' });
    const r2 = await request(a).patch(`/team/${ADMIN2_A}/units`).set(bearer('adminA')).set(org(ORG_A)).send({ unit_ids: [] });
    const r3 = await request(a).delete(`/team/${ADMIN2_A}`).set(bearer('adminA')).set(org(ORG_A));
    expect([r1.status, r2.status, r3.status]).toEqual([403, 403, 403]);
    expect(db.tables.memberships.find((m) => m.user_id === ADMIN2_A)).toEqual(before);
  });

  it('admin NÃO altera a própria membership (papel/status/unidades/remoção) -> 403 em todos', async () => {
    const a = await app('true', 'true');
    const before = { ...db.tables.memberships.find((m) => m.user_id === ADMIN_A) };
    const r1 = await request(a).patch(`/team/${ADMIN_A}/role`).set(bearer('adminA')).set(org(ORG_A)).send({ role: 'closer' });
    const r2 = await request(a).patch(`/team/${ADMIN_A}/status`).set(bearer('adminA')).set(org(ORG_A)).send({ status: 'suspended' });
    const r3 = await request(a).patch(`/team/${ADMIN_A}/units`).set(bearer('adminA')).set(org(ORG_A)).send({ unit_ids: [] });
    const r4 = await request(a).delete(`/team/${ADMIN_A}`).set(bearer('adminA')).set(org(ORG_A));
    expect([r1.status, r2.status, r3.status, r4.status]).toEqual([403, 403, 403, 403]);
    expect(db.tables.memberships.find((m) => m.user_id === ADMIN_A)).toEqual(before);
  });

  it('admin NÃO administra organization_owner (papel/status/remoção/unidades) -> 403', async () => {
    const a = await app('true', 'true');
    const r1 = await request(a).patch(`/team/${OWNER_A}/role`).set(bearer('adminA')).set(org(ORG_A)).send({ role: 'manager' });
    const r2 = await request(a).patch(`/team/${OWNER_A}/status`).set(bearer('adminA')).set(org(ORG_A)).send({ status: 'suspended' });
    const r3 = await request(a).delete(`/team/${OWNER_A}`).set(bearer('adminA')).set(org(ORG_A));
    expect([r1.status, r2.status, r3.status]).toEqual([403, 403, 403]);
  });

  it('owner CONSEGUE administrar admin da própria organização (papel/status/unidades)', async () => {
    const a = await app('true', 'true');
    const r1 = await request(a).patch(`/team/${ADMIN2_A}/role`).set(bearer('ownerA')).set(org(ORG_A)).send({ role: 'manager' });
    expect(r1.status).toBe(200);
    const r2 = await request(a).patch(`/team/${ADMIN2_A}/status`).set(bearer('ownerA')).set(org(ORG_A)).send({ status: 'suspended' });
    expect(r2.status).toBe(200);
  });

  it('owner NÃO administra membro de outra organização (cross-tenant -> 404)', async () => {
    const a = await app('true', 'true');
    const res = await request(a).patch(`/team/${OWNER_B}/role`).set(bearer('ownerA')).set(org(ORG_A)).send({ role: 'manager' });
    expect(res.status).toBe(404);
  });

  it('concorrência: dois admins tentando mexer um no outro ao mesmo tempo -> ambos 403, nada muda', async () => {
    const a = await app('true', 'true');
    const [r1, r2] = await Promise.all([
      request(a).patch(`/team/${ADMIN2_A}/role`).set(bearer('adminA')).set(org(ORG_A)).send({ role: 'viewer' }),
      request(a).patch(`/team/${ADMIN_A}/role`).set(bearer('admin2A')).set(org(ORG_A)).send({ role: 'viewer' }),
    ]);
    expect([r1.status, r2.status]).toEqual([403, 403]);
    expect(db.tables.memberships.find((m) => m.user_id === ADMIN_A).role).toBe('organization_admin');
    expect(db.tables.memberships.find((m) => m.user_id === ADMIN2_A).role).toBe('organization_admin');
  });

  it('negação de hierarquia não gera evento de auditoria com PII (nem evento nenhum, já que falha antes do insert)', async () => {
    const a = await app('true', 'true');
    await request(a).patch(`/team/${ADMIN2_A}/role`).set(bearer('adminA')).set(org(ORG_A)).send({ role: 'closer' });
    const eventos = db.tables.team_membership_events.filter((e) => e.target_user_id === ADMIN2_A);
    expect(eventos).toHaveLength(0);
  });

  it('último owner: não pode ser rebaixado, suspenso nem removido -> 409', async () => {
    const a = await app('true', 'true');
    const rebaixar = await request(a).patch(`/team/${OWNER_A}/role`).set(bearer('ownerA')).set(org(ORG_A)).send({ role: 'manager' });
    expect(rebaixar.status).toBe(409);
    expect(rebaixar.body.error).toBe('last_owner_protected');

    const suspender = await request(a).patch(`/team/${OWNER_A}/status`).set(bearer('ownerA')).set(org(ORG_A)).send({ status: 'suspended' });
    expect(suspender.status).toBe(409);

    const remover = await request(a).delete(`/team/${OWNER_A}`).set(bearer('ownerA')).set(org(ORG_A));
    expect(remover.status).toBe(409);
  });

  it('dois owners: dá para rebaixar/remover um deles', async () => {
    seed({
      memberships: [
        { organization_id: ORG_A, user_id: OWNER_A, role: 'organization_owner', status: 'active' },
        { organization_id: ORG_A, user_id: ADMIN_A, role: 'organization_owner', status: 'active' },
      ],
    });
    const a = await app('true', 'true');
    const res = await request(a).patch(`/team/${ADMIN_A}/role`).set(bearer('ownerA')).set(org(ORG_A)).send({ role: 'manager' });
    expect(res.status).toBe(200);
  });

  it('suspender e reativar: fluxo completo', async () => {
    const a = await app('true', 'true');
    const s = await request(a).patch(`/team/${CLOSER_A}/status`).set(bearer('ownerA')).set(org(ORG_A)).send({ status: 'suspended' });
    expect(s.status).toBe(200);
    expect(s.body.status).toBe('suspended');
    expect(db.tables.user_doctor_access.some((r) => r.user_id === CLOSER_A)).toBe(false); // ponte removida
    const r = await request(a).patch(`/team/${CLOSER_A}/status`).set(bearer('ownerA')).set(org(ORG_A)).send({ status: 'active' });
    expect(r.status).toBe(200);
    expect(db.tables.user_doctor_access.some((r2) => r2.user_id === CLOSER_A)).toBe(true); // ponte restaurada
  });

  it('remover membro -> 204, membership some, ponte removida', async () => {
    const a = await app('true', 'true');
    const res = await request(a).delete(`/team/${CLOSER_A}`).set(bearer('ownerA')).set(org(ORG_A));
    expect(res.status).toBe(204);
    expect(db.tables.memberships.some((m) => m.user_id === CLOSER_A)).toBe(false);
    expect(db.tables.user_doctor_access.some((r) => r.user_id === CLOSER_A)).toBe(false);
  });

  it('cross-tenant: owner A não altera membro da org B -> 404', async () => {
    const a = await app('true', 'true');
    const res = await request(a).patch(`/team/${OWNER_B}/role`).set(bearer('ownerA')).set(org(ORG_A)).send({ role: 'manager' });
    expect(res.status).toBe(404);
  });

  it('unit_id de outra organização -> 400', async () => {
    const a = await app('true', 'true');
    const res = await request(a).patch(`/team/${CLOSER_A}/units`).set(bearer('ownerA')).set(org(ORG_A)).send({ unit_ids: [UNIT_B1] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unit_not_in_organization');
  });

  it('unit_id da própria organização -> 200', async () => {
    const a = await app('true', 'true');
    const res = await request(a).patch(`/team/${CLOSER_A}/units`).set(bearer('ownerA')).set(org(ORG_A)).send({ unit_ids: [UNIT_A1] });
    expect(res.status).toBe(200);
    expect(res.body.unit_ids).toEqual([UNIT_A1]);
  });

  it('membership suspensa não é gerenciável por si mesma (closer suspenso não vira ator)', async () => {
    seed({
      memberships: [
        { organization_id: ORG_A, user_id: OWNER_A, role: 'organization_owner', status: 'active' },
        { organization_id: ORG_A, user_id: ADMIN_A, role: 'organization_admin', status: 'suspended' },
      ],
    });
    const a = await app('true', 'true');
    const res = await request(a).patch(`/team/${OWNER_A}/role`).set(bearer('adminA')).set(org(ORG_A)).send({ role: 'manager' });
    expect(res.status).toBe(403);
  });

  it('nenhuma resposta expõe segredo/token', async () => {
    const a = await app('true', 'true');
    const res = await request(a).get('/team').set(bearer('ownerA')).set(org(ORG_A));
    expect(JSON.stringify(res.body)).not.toMatch(/token|senha|password/i);
  });

  it('rate limit: 21ª mutação no minuto -> 429', async () => {
    const a = await app('true', 'true');
    for (let i = 0; i < 20; i += 1) {
      await request(a).patch(`/team/${CLOSER_A}/units`).set(bearer('ownerA')).set(org(ORG_A)).send({ unit_ids: [] });
    }
    const res = await request(a).patch(`/team/${CLOSER_A}/units`).set(bearer('ownerA')).set(org(ORG_A)).send({ unit_ids: [] });
    expect(res.status).toBe(429);
  });
});

describe('/team — flag desligada (compat legado, sem regressão)', () => {
  beforeEach(() => seed());

  it('GET /team continua respondendo pelo user_doctor_access', async () => {
    const a = await app('false', 'false');
    const res = await request(a).get('/team').query({ doctor_id: DOC_A }).set(bearer('ownerA'));
    expect(res.status).toBe(200);
    expect(res.body.membros.some((m) => m.id === CLOSER_A)).toBe(true);
  });

  it('rotas novas (role/status/units) não existem sob a flag -> 404', async () => {
    const a = await app('false', 'false');
    expect((await request(a).patch(`/team/${CLOSER_A}/role`).set(bearer('ownerA')).send({ role: 'manager' })).status).toBe(404);
    expect((await request(a).patch(`/team/${CLOSER_A}/status`).set(bearer('ownerA')).send({ status: 'suspended' })).status).toBe(404);
    expect((await request(a).patch(`/team/${CLOSER_A}/units`).set(bearer('ownerA')).send({ unit_ids: [] })).status).toBe(404);
  });

  it('POST /team continua criando só closer (legado)', async () => {
    const a = await app('false', 'false');
    const res = await request(a).post('/team').set(bearer('ownerA')).send({ doctor_id: DOC_A, nome: 'X', email: 'legacy@x.com' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('closer');
  });

  it('DELETE /team/:userId continua removendo só o vínculo legado', async () => {
    const a = await app('false', 'false');
    const res = await request(a).delete(`/team/${CLOSER_A}`).query({ doctor_id: DOC_A }).set(bearer('ownerA'));
    expect(res.status).toBe(204);
    expect(db.tables.memberships.some((m) => m.user_id === CLOSER_A)).toBe(true); // membership não é tocada no legado
  });
});

describe('/team — tenant core ligado mas TEAM_MEMBERSHIPS_ENABLED=false', () => {
  beforeEach(() => seed());
  it('continua no caminho legado (a flag de equipe manda, não a de tenant)', async () => {
    const a = await app('true', 'false');
    const res = await request(a).get('/team').query({ doctor_id: DOC_A }).set(bearer('ownerA'));
    expect(res.status).toBe(200);
    expect(res.body.membros.some((m) => m.id === CLOSER_A)).toBe(true);
  });
});
