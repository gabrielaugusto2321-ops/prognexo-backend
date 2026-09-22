import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
afterEach(() => { delete process.env.TENANT_CORE_ENABLED; vi.resetModules(); });
const U = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D = U(1); const ORG = U(2); const OWNER = U(3); const CLOSER = U(4); const MEMBER = U(5); const ADMIN = U(6); const PAD = U(7);
const auth = (token, org) => ({ Authorization: `Bearer ${token}`, ...(org ? { 'X-Organization-Id': org } : {}) });
async function app(flag) { vi.resetModules(); process.env.TENANT_CORE_ENABLED = flag; return (await import('../src/server.js')).createApp(); }

function seed(expiration) {
  db = makeDb({
    users: [OWNER, CLOSER, MEMBER, PAD].map((id) => ({ id, role: id === CLOSER ? 'closer' : 'doctor', ativo: true })).concat({ id: ADMIN, role: 'admin', ativo: true }),
    doctors: [{ id: D, owner_user_id: OWNER, courtesy_expires_at: expiration }],
    user_doctor_access: [{ user_id: CLOSER, doctor_id: D }],
    platform_admins: [{ user_id: PAD }],
    organizations: [{ id: ORG }], units: [], organization_doctor_map: [{ organization_id: ORG, doctor_id: D }],
    memberships: [
      { id: 'mo', organization_id: ORG, user_id: OWNER, role: 'organization_owner', status: 'active' },
      { id: 'mc', organization_id: ORG, user_id: CLOSER, role: 'closer', status: 'active' },
      { id: 'mm', organization_id: ORG, user_id: MEMBER, role: 'viewer', status: 'active' },
    ], membership_units: [],
  });
  for (const [token, id] of [['owner', OWNER], ['closer', CLOSER], ['member', MEMBER], ['admin', ADMIN], ['pad', PAD]]) db.setAuthUser(token, { id });
}

describe.each(['false', 'true'])('courtesy expiration tenant=%s', (flag) => {
  beforeEach(() => seed(new Date(Date.now() - 60_000).toISOString()));
  it.each(['owner', 'closer'])('blocks expired %s', async (token) => {
    const response = await request(await app(flag)).get('/doctors').set(auth(token, flag === 'true' ? ORG : null));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'courtesy_expired' });
  });
  // MEMBER só tem vínculo por membership (papel 'viewer'), nunca é dono nem
  // tem acesso legado (user_doctor_access) — em modo legado, sem cabeçalho
  // de organização, o gate nunca deve bloquear por ambiguidade/impossível
  // de resolver um único doctor; em modo tenant, o cabeçalho resolve o
  // doctor certo e bloqueia normalmente.
  it(`${flag === 'true' ? 'blocks' : 'does not block'} expired member`, async () => {
    const response = await request(await app(flag)).get('/doctors').set(auth('member', flag === 'true' ? ORG : null));
    expect(response.status).toBe(flag === 'true' ? 403 : 200);
  });
  it.each(['admin', 'pad'])('allows platform admin %s', async (token) => {
    const response = await request(await app(flag)).get('/admin/doctors').set(auth(token));
    expect(response.status).toBe(200);
  });
  it.each([null, new Date(Date.now() + 86_400_000).toISOString()])('allows null/future expiration %s', async (expiration) => {
    seed(expiration);
    const response = await request(await app(flag)).get('/doctors').set(auth('owner', flag === 'true' ? ORG : null));
    expect(response.status).toBe(200);
  });
  it('/tenant/context permanece acessível mesmo com a cortesia vencida', async () => {
    const response = await request(await app(flag)).get('/tenant/context').set(auth('owner', flag === 'true' ? ORG : null));
    expect(response.status).toBe(200);
  });
});

// Cenário multi-organização: OWNER2 não é dono de nenhum doctor legado nem
// tem user_doctor_access — só chega a um doctor específico via
// X-Organization-Id. Uma organização vencida NUNCA pode bloquear acesso a
// outra organização válida do mesmo usuário, e sem cabeçalho (ambíguo entre
// duas orgs) o gate não bloqueia (autorização por rota decide).
describe('courtesy expiration — múltiplas organizações', () => {
  const OWNER2 = U(8); const ORG_A = U(9); const ORG_B = U(10); const DOC_A = U(12); const DOC_B = U(13);

  function seedMultiOrg({ expiraA, expiraB }) {
    db = makeDb({
      users: [{ id: OWNER2, role: 'doctor', ativo: true }],
      doctors: [
        { id: DOC_A, owner_user_id: null, courtesy_expires_at: expiraA },
        { id: DOC_B, owner_user_id: null, courtesy_expires_at: expiraB },
      ],
      organizations: [{ id: ORG_A }, { id: ORG_B }],
      organization_doctor_map: [
        { organization_id: ORG_A, doctor_id: DOC_A },
        { organization_id: ORG_B, doctor_id: DOC_B },
      ],
      memberships: [
        { id: 'ma', organization_id: ORG_A, user_id: OWNER2, role: 'organization_owner', status: 'active' },
        { id: 'mb', organization_id: ORG_B, user_id: OWNER2, role: 'organization_owner', status: 'active' },
      ],
      membership_units: [],
    });
    db.setAuthUser('owner2', { id: OWNER2 });
  }

  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 86_400_000).toISOString();

  it('organização A vencida não bloqueia acesso à organização B válida', async () => {
    seedMultiOrg({ expiraA: past, expiraB: future });
    const api = await app('true');
    const respA = await request(api).get('/doctors').set(auth('owner2', ORG_A));
    expect(respA.status).toBe(403);
    expect(respA.body).toEqual({ error: 'courtesy_expired' });
    const respB = await request(api).get('/doctors').set(auth('owner2', ORG_B));
    expect(respB.status).toBe(200);
  });

  it('seleção explícita de organização vencida é bloqueada', async () => {
    seedMultiOrg({ expiraA: past, expiraB: future });
    const response = await request(await app('true')).get('/doctors').set(auth('owner2', ORG_A));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'courtesy_expired' });
  });

  it('todas as organizações vencidas: cada uma bloqueada individualmente ao ser selecionada', async () => {
    seedMultiOrg({ expiraA: past, expiraB: past });
    const api = await app('true');
    for (const org of [ORG_A, ORG_B]) {
      const response = await request(api).get('/doctors').set(auth('owner2', org));
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'courtesy_expired' });
    }
  });

  it('sem cabeçalho de organização (ambíguo entre A e B), o gate de cortesia não é quem bloqueia', async () => {
    // Sem X-Organization-Id e >1 organização ativa, attachTenantContext já
    // exige seleção (409 organization_selection_required) ANTES de qualquer
    // lógica de rota — um gate diferente, preexistente, nada a ver com
    // cortesia. O que este teste prova: NÃO é '403 courtesy_expired' (o que
    // aconteceria se o gate de cortesia bloqueasse erroneamente por
    // ambiguidade antes mesmo da seleção de organização).
    seedMultiOrg({ expiraA: past, expiraB: past });
    const response = await request(await app('true')).get('/doctors').set(auth('owner2', null));
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'organization_selection_required' });
  });

  it('/tenant/context sempre acessível, mesmo com todas as organizações vencidas', async () => {
    seedMultiOrg({ expiraA: past, expiraB: past });
    const response = await request(await app('true')).get('/tenant/context').set(auth('owner2', null));
    expect(response.status).toBe(200);
  });
});

// Pausar/reativar: bloqueia rotas autenticadas com erro explícito e restaura
// o acesso ao reativar. courtesy_expires_at NULL não interfere.
describe('account pause/reactivate gate', () => {
  it('doctor pausado bloqueia rotas autenticadas com account_paused; reativar restaura o acesso', async () => {
    db = makeDb({
      users: [{ id: OWNER, role: 'doctor', ativo: true }, { id: ADMIN, role: 'admin', ativo: true }],
      doctors: [{ id: D, owner_user_id: OWNER, status: 'ativo', courtesy_expires_at: null }],
    });
    db.setAuthUser('owner', { id: OWNER });
    db.setAuthUser('admin', { id: ADMIN });
    const api = await app('false');

    expect((await request(api).get('/doctors').set(auth('owner'))).status).toBe(200);

    const paused = await request(api).patch(`/admin/doctors/${D}/pause`).set(auth('admin'));
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('pausado');

    const blocked = await request(api).get('/doctors').set(auth('owner'));
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({ error: 'account_paused' });

    const reactivated = await request(api).patch(`/admin/doctors/${D}/reactivate`).set(auth('admin'));
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.status).toBe('ativo');

    const restored = await request(api).get('/doctors').set(auth('owner'));
    expect(restored.status).toBe(200);
  });
});

// Precisão cirúrgica da isenção: SÓ GET /tenant/context escapa do gate.
// Qualquer outra rota sob /tenant (ex.: /tenant/shadow-metrics) continua
// passando pela checagem normalmente — provando que a isenção não é um
// prefixo genérico de baseUrl.
describe('isenção de cortesia é exata (método+baseUrl+path), não um prefixo /tenant genérico', () => {
  beforeEach(() => seed(new Date(Date.now() - 60_000).toISOString()));

  it('GET /tenant/context funciona com cortesia vencida', async () => {
    const response = await request(await app('false')).get('/tenant/context').set(auth('owner'));
    expect(response.status).toBe(200);
  });

  it('GET /tenant/shadow-metrics continua bloqueada com courtesy_expired (mesmo baseUrl /tenant, path diferente)', async () => {
    const response = await request(await app('false')).get('/tenant/shadow-metrics').set(auth('owner'));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'courtesy_expired' });
  });

  it('doctor pausado: GET /tenant/context ainda funciona, GET /tenant/shadow-metrics é bloqueada com account_paused', async () => {
    db.tables.doctors.find((d) => d.id === D).status = 'pausado';
    db.tables.doctors.find((d) => d.id === D).courtesy_expires_at = null;
    const api = await app('false');
    const context = await request(api).get('/tenant/context').set(auth('owner'));
    expect(context.status).toBe(200);
    const shadow = await request(api).get('/tenant/shadow-metrics').set(auth('owner'));
    expect(shadow.status).toBe(403);
    expect(shadow.body).toEqual({ error: 'account_paused' });
  });
});
