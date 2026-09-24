import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
afterEach(() => { delete process.env.TENANT_CORE_ENABLED; vi.resetModules(); });

// Aquece a árvore de imports pesada (googleapis etc.) FORA do relógio do teste:
// sob a carga da suíte completa o 1º import do servidor estoura os 30s.
// Mesmo padrão de test/team-api.test.js.
await import('../src/server.js');

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER_A = U(1); const MANAGER_A = U(2); const ADMIN_A = U(3); const CLOSER_A = U(4); const PROF_A = U(5);
const OWNER_B = U(6); const LEGACY_DOC = U(7); const LEGACY_ADMIN = U(8); const NO_MEMBERSHIP = U(9);
const D_A = U(11); const D_B = U(12); const D_L = U(13);
const ORG_A = U(21); const ORG_B = U(22);
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const VALID = {
  name: 'Ebook Emagrecimento',
  allowed_origins: ['https://drexemplo.com.br'],
  consent_text: 'Autorizo receber mensagens por WhatsApp sobre este conteúdo.',
};

async function app(flag = 'true') {
  vi.resetModules();
  process.env.TENANT_CORE_ENABLED = flag;
  return (await import('../src/server.js')).createApp();
}

beforeEach(() => {
  db = makeDb({
    users: [
      { id: OWNER_A, email: 'owner-a@t', role: 'doctor', ativo: true },
      // users.role legado NÃO decide em modo tenant: a membership manda.
      { id: MANAGER_A, email: 'manager-a@t', role: 'closer', ativo: true },
      { id: ADMIN_A, email: 'admin-a@t', role: 'doctor', ativo: true },
      { id: CLOSER_A, email: 'closer-a@t', role: 'closer', ativo: true },
      { id: PROF_A, email: 'prof-a@t', role: 'doctor', ativo: true },
      { id: OWNER_B, email: 'owner-b@t', role: 'doctor', ativo: true },
      { id: LEGACY_DOC, email: 'legacy@t', role: 'doctor', ativo: true },
      { id: LEGACY_ADMIN, email: 'legacy-admin@t', role: 'admin', ativo: true },
      { id: NO_MEMBERSHIP, email: 'nomember@t', role: 'doctor', ativo: true },
    ],
    doctors: [
      { id: D_A, owner_user_id: OWNER_A, nome: 'Clinica A', status: 'ativo', courtesy_expires_at: null },
      { id: D_B, owner_user_id: OWNER_B, nome: 'Clinica B', status: 'ativo', courtesy_expires_at: null },
      { id: D_L, owner_user_id: LEGACY_DOC, nome: 'Clinica Legado', status: 'ativo', courtesy_expires_at: null },
    ],
    organizations: [{ id: ORG_A, name: 'Tenant A' }, { id: ORG_B, name: 'Tenant B' }],
    organization_doctor_map: [{ organization_id: ORG_A, doctor_id: D_A }, { organization_id: ORG_B, doctor_id: D_B }],
    memberships: [
      { id: 'm1', organization_id: ORG_A, user_id: OWNER_A, role: 'organization_owner', status: 'active' },
      { id: 'm2', organization_id: ORG_A, user_id: MANAGER_A, role: 'manager', status: 'active' },
      { id: 'm3', organization_id: ORG_A, user_id: ADMIN_A, role: 'organization_admin', status: 'active' },
      { id: 'm4', organization_id: ORG_A, user_id: CLOSER_A, role: 'closer', status: 'active' },
      { id: 'm5', organization_id: ORG_A, user_id: PROF_A, role: 'professional', status: 'active' },
      { id: 'm6', organization_id: ORG_B, user_id: OWNER_B, role: 'organization_owner', status: 'active' },
    ],
    lead_capture_forms: [], lead_capture_form_consent_versions: [],
  });
  for (const [token, id] of [['ownerA', OWNER_A], ['managerA', MANAGER_A], ['adminA', ADMIN_A], ['closerA', CLOSER_A], ['profA', PROF_A],
    ['ownerB', OWNER_B], ['legacyDoc', LEGACY_DOC], ['legacyAdmin', LEGACY_ADMIN], ['noMember', NO_MEMBERSHIP]]) db.setAuthUser(token, { id });
});

async function createForm(api, token, extra = {}) {
  const response = await request(api).post('/lead-forms').set(auth(token)).send({ ...VALID, ...extra });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

describe('autorização (tenant ligado)', () => {
  it('sem token -> 401', async () => {
    const api = await app();
    expect((await request(api).get('/lead-forms')).status).toBe(401);
    expect((await request(api).post('/lead-forms').send(VALID)).status).toBe(401);
  });

  it.each(['ownerA', 'adminA', 'managerA'])('%s gerencia formulários do próprio tenant', async (token) => {
    const api = await app();
    const created = await request(api).post('/lead-forms').set(auth(token)).send(VALID);
    expect(created.status).toBe(201);
    expect((await request(api).get('/lead-forms').set(auth(token))).status).toBe(200);
  });

  it.each(['closerA', 'profA', 'noMember'])('%s (closer/professional/sem membership) -> 403 em tudo', async (token) => {
    const api = await app();
    const seeded = await createForm(api, 'ownerA');
    for (const [method, url, body] of [['get', '/lead-forms'], ['post', '/lead-forms', VALID], ['patch', `/lead-forms/${seeded.id}`, { active: false }]]) {
      const response = await request(api)[method](url).set(auth(token)).send(body);
      expect(response.status, `${token} ${method} ${url}`).toBe(403);
    }
    expect(db.tables.lead_capture_forms).toHaveLength(1);
    expect(db.tables.lead_capture_forms[0].active).toBe(true);
  });
});

describe('criação: tenant derivado do contexto, nunca do corpo', () => {
  it('grava doctor_id/organization_id do tenant do chamador e devolve o contrato exato', async () => {
    const api = await app();
    const form = await createForm(api, 'ownerA', { redirect_url: 'https://drexemplo.com.br/ebook', success_message: 'Obrigado!' });
    const row = db.tables.lead_capture_forms[0];
    expect(row.doctor_id).toBe(D_A);
    expect(row.organization_id).toBe(ORG_A);
    expect(row.created_by).toBe(OWNER_A);
    expect(row.active).toBe(true);
    expect(form.public_id).toMatch(/^lf_[A-Za-z0-9_-]{16}$/);
    expect(row.public_id).toBe(form.public_id);
    expect(Object.keys(form).sort()).toEqual(expect.arrayContaining(['id', 'public_id', 'name', 'active', 'allowed_origins', 'pipeline_stage', 'redirect_url', 'success_message', 'consent_text', 'consent_version']));
    expect(form).not.toHaveProperty('doctor_id');
    expect(form).not.toHaveProperty('organization_id');
    expect(form.consent_version).toBe(1);
    expect(form.consent_text).toBe(VALID.consent_text);
    expect(form.pipeline_stage).toBe('lead');
    expect(db.tables.lead_capture_form_consent_versions).toEqual([expect.objectContaining({ form_id: row.id, version: 1, consent_text: VALID.consent_text })]);
  });

  it('o mesmo pedido feito no tenant B cai no médico B', async () => {
    const api = await app();
    await createForm(api, 'ownerB');
    expect(db.tables.lead_capture_forms[0].doctor_id).toBe(D_B);
    expect(db.tables.lead_capture_forms[0].organization_id).toBe(ORG_B);
  });

  it.each([
    ['doctor_id', D_B], ['organization_id', ORG_B], ['public_id', 'lf_AAAAAAAAAAAAAAAA'], ['id', U(99)], ['active', false], ['consent_version', 9],
  ])('campo %s no corpo -> 400 e nada é gravado (spoofing)', async (key, value) => {
    const api = await app();
    const response = await request(api).post('/lead-forms').set(auth('ownerA')).send({ ...VALID, [key]: value });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_payload' });
    expect(db.tables.lead_capture_forms).toHaveLength(0);
    expect(db.tables.lead_capture_form_consent_versions).toHaveLength(0);
  });

  it('nunca aceita null no POST (contrato: opcionais são omitidos)', async () => {
    const api = await app();
    expect((await request(api).post('/lead-forms').set(auth('ownerA')).send({ ...VALID, redirect_url: null })).status).toBe(400);
    expect((await request(api).post('/lead-forms').set(auth('ownerA')).send({ ...VALID, success_message: null })).status).toBe(400);
  });

  it.each([
    ['nome curto', { name: 'a' }],
    ['consentimento curto', { consent_text: 'curto' }],
    ['sem domínio', { allowed_origins: [] }],
    ['mais de 10 domínios', { allowed_origins: Array.from({ length: 11 }, (_, i) => `https://s${i}.com.br`) }],
    ['http em domínio real', { allowed_origins: ['http://drexemplo.com.br'] }],
    ['curinga', { allowed_origins: ['https://*.drexemplo.com.br'] }],
    ['com caminho', { allowed_origins: ['https://drexemplo.com.br/pagina'] }],
    ['com consulta', { allowed_origins: ['https://drexemplo.com.br/?a=1'] }],
    ['com credenciais', { allowed_origins: ['https://user:pass@drexemplo.com.br'] }],
    ['não é URL', { allowed_origins: ['drexemplo'] }],
    ['etapa inválida', { pipeline_stage: 'fechado' }],
    ['redirect http', { redirect_url: 'http://drexemplo.com.br/ebook' }],
    ['redirect javascript:', { redirect_url: 'javascript:alert(1)' }],
    ['mensagem longa', { success_message: 'x'.repeat(301) }],
  ])('rejeita: %s', async (_label, patch) => {
    const api = await app();
    const response = await request(api).post('/lead-forms').set(auth('ownerA')).send({ ...VALID, ...patch });
    expect(response.status).toBe(400);
    expect(db.tables.lead_capture_forms).toHaveLength(0);
  });

  it('normaliza domínios para origem pura e remove duplicados', async () => {
    const api = await app();
    const form = await createForm(api, 'ownerA', {
      allowed_origins: ['https://DrExemplo.com.br/', 'https://drexemplo.com.br', 'https://www.drexemplo.com.br:443/'],
    });
    expect(form.allowed_origins).toEqual(['https://drexemplo.com.br', 'https://www.drexemplo.com.br']);
  });

  it('desfaz o formulário se a versão 1 do consentimento não puder ser gravada (sem prova, sem formulário)', async () => {
    const api = await app();
    db.failNextWrite('lead_capture_form_consent_versions', 'insert');
    const response = await request(api).post('/lead-forms').set(auth('ownerA')).send(VALID);
    expect(response.status).toBe(500);
    expect(db.tables.lead_capture_forms).toHaveLength(0);
  });
});

describe('listagem e edição: isolamento entre tenants', () => {
  it('GET lista só os formulários do próprio tenant', async () => {
    const api = await app();
    const a = await createForm(api, 'ownerA', { name: 'Form A' });
    const b = await createForm(api, 'ownerB', { name: 'Form B' });
    const listA = await request(api).get('/lead-forms').set(auth('ownerA'));
    const listB = await request(api).get('/lead-forms').set(auth('ownerB'));
    expect(listA.body.map((f) => f.id)).toEqual([a.id]);
    expect(listB.body.map((f) => f.id)).toEqual([b.id]);
  });

  it('PATCH em formulário de outro tenant -> 404 (nunca 403) e nada muda', async () => {
    const api = await app();
    const a = await createForm(api, 'ownerA');
    const before = JSON.stringify(db.tables.lead_capture_forms);
    const response = await request(api).patch(`/lead-forms/${a.id}`).set(auth('ownerB')).send({ active: false, name: 'Sequestrado' });
    expect(response.status).toBe(404);
    expect(JSON.stringify(db.tables.lead_capture_forms)).toBe(before);
  });

  it('PATCH em id inexistente -> 404', async () => {
    const api = await app();
    expect((await request(api).patch(`/lead-forms/${U(999)}`).set(auth('ownerA')).send({ active: false })).status).toBe(404);
  });

  it.each([['doctor_id', D_B], ['organization_id', ORG_B], ['public_id', 'lf_BBBBBBBBBBBBBBBB'], ['consent_version', 7]])('PATCH com %s no corpo -> 400', async (key, value) => {
    const api = await app();
    const a = await createForm(api, 'ownerA');
    const response = await request(api).patch(`/lead-forms/${a.id}`).set(auth('ownerA')).send({ [key]: value });
    expect(response.status).toBe(400);
    expect(db.tables.lead_capture_forms[0].doctor_id).toBe(D_A);
  });

  it('PATCH vazio -> 400', async () => {
    const api = await app();
    const a = await createForm(api, 'ownerA');
    expect((await request(api).patch(`/lead-forms/${a.id}`).set(auth('ownerA')).send({})).status).toBe(400);
  });
});

describe('edição: desativar, domínios e versionamento do consentimento', () => {
  it('desativa e reativa (não existe DELETE: a prova precisa ficar)', async () => {
    const api = await app();
    const form = await createForm(api, 'ownerA');
    const off = await request(api).patch(`/lead-forms/${form.id}`).set(auth('ownerA')).send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    const on = await request(api).patch(`/lead-forms/${form.id}`).set(auth('ownerA')).send({ active: true });
    expect(on.body.active).toBe(true);
    expect((await request(api).delete(`/lead-forms/${form.id}`).set(auth('ownerA'))).status).toBe(404);
    expect(db.tables.lead_capture_forms).toHaveLength(1);
  });

  it('texto novo cria a versão 2 e preserva a 1 (histórico imutável)', async () => {
    const api = await app();
    const form = await createForm(api, 'ownerA');
    const novo = 'Autorizo o contato por WhatsApp e e-mail sobre este material.';
    const response = await request(api).patch(`/lead-forms/${form.id}`).set(auth('ownerA')).send({ consent_text: novo });
    expect(response.status).toBe(200);
    expect(response.body.consent_version).toBe(2);
    expect(response.body.consent_text).toBe(novo);
    expect(db.tables.lead_capture_form_consent_versions.map((v) => [v.version, v.consent_text])).toEqual([[1, VALID.consent_text], [2, novo]]);
  });

  it('texto idêntico ao atual NÃO cria versão nova', async () => {
    const api = await app();
    const form = await createForm(api, 'ownerA');
    const response = await request(api).patch(`/lead-forms/${form.id}`).set(auth('ownerA')).send({ consent_text: VALID.consent_text, name: 'Outro nome' });
    expect(response.status).toBe(200);
    expect(response.body.consent_version).toBe(1);
    expect(db.tables.lead_capture_form_consent_versions).toHaveLength(1);
  });

  it('limpa redirect/mensagem com null e revalida domínios', async () => {
    const api = await app();
    const form = await createForm(api, 'ownerA', { redirect_url: 'https://drexemplo.com.br/e', success_message: 'Oi' });
    const cleared = await request(api).patch(`/lead-forms/${form.id}`).set(auth('ownerA')).send({ redirect_url: null, success_message: null });
    expect(cleared.body.redirect_url).toBeNull();
    expect(cleared.body.success_message).toBeNull();
    expect((await request(api).patch(`/lead-forms/${form.id}`).set(auth('ownerA')).send({ allowed_origins: ['http://x.com.br'] })).status).toBe(400);
    const changed = await request(api).patch(`/lead-forms/${form.id}`).set(auth('ownerA')).send({ allowed_origins: ['https://Novo.com.br/'] });
    expect(changed.body.allowed_origins).toEqual(['https://novo.com.br']);
  });
});

describe('modo legado (tenant desligado)', () => {
  it('médico cria no PRÓPRIO médico; membership/role de closer não gerencia', async () => {
    const api = await app('false');
    const form = await createForm(api, 'legacyDoc');
    expect(db.tables.lead_capture_forms[0].doctor_id).toBe(D_L);
    expect(db.tables.lead_capture_forms[0].organization_id).toBeNull();
    expect(form.public_id).toMatch(/^lf_/);
    // users.role='closer' (mesmo com membership manager) não gerencia sem tenant.
    expect((await request(api).get('/lead-forms').set(auth('managerA'))).status).toBe(403);
    expect((await request(api).get('/lead-forms').set(auth('closerA'))).status).toBe(403);
  });

  it('isolamento: médico legado só vê e edita os próprios', async () => {
    const api = await app('false');
    const mine = await createForm(api, 'legacyDoc');
    db.tables.lead_capture_forms.push({ id: U(500), public_id: 'lf_XXXXXXXXXXXXXXXX', doctor_id: D_A, name: 'Alheio', allowed_origins: ['https://a.test'], pipeline_stage: 'lead', consent_version: 1, active: true, criado_em: new Date().toISOString() });
    const list = await request(api).get('/lead-forms').set(auth('legacyDoc'));
    expect(list.body.map((f) => f.id)).toEqual([mine.id]);
    expect((await request(api).patch(`/lead-forms/${U(500)}`).set(auth('legacyDoc')).send({ active: false })).status).toBe(404);
    expect(db.tables.lead_capture_forms.find((f) => f.id === U(500)).active).toBe(true);
  });

  it('admin legado lista, mas não cria (não há como escolher o médico)', async () => {
    const api = await app('false');
    await createForm(api, 'legacyDoc');
    const list = await request(api).get('/lead-forms').set(auth('legacyAdmin'));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect((await request(api).post('/lead-forms').set(auth('legacyAdmin')).send(VALID)).status).toBe(403);
  });
});
