import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
process.env.META_SYSTEM_USER_TOKEN = 'system-fallback-token';

let db;
let fetchImpl;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('node-fetch', () => ({})); // no-op se algum dia existir; garante que usamos o fetch global

const { app } = await import('../src/server.js');

const OWNER = '00000000-0000-4000-9000-000000000u01';
const CLOSER = '00000000-0000-4000-9000-000000000u02';
const DOC_A = '00000000-0000-4000-9000-0000000000da';
const DOC_B = '00000000-0000-4000-9000-0000000000db';

function metaTemplate(id, overrides = {}) {
  return {
    id, name: `template_${id}`, status: 'APPROVED', language: 'pt_BR', category: 'UTILITY',
    parameter_format: 'POSITIONAL',
    components: [{ type: 'BODY', text: 'Olá {{1}}!' }],
    ...overrides,
  };
}

function mockGraphSinglePage(items) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: items, paging: { cursors: {} } }),
  }));
}

beforeEach(() => {
  fetchImpl = null;
  db = makeDb({
    users: [{ id: OWNER, role: 'doctor', ativo: true }, { id: CLOSER, role: 'closer', ativo: true }],
    doctors: [{ id: DOC_A, owner_user_id: OWNER }, { id: DOC_B }],
    user_doctor_access: [{ user_id: CLOSER, doctor_id: DOC_A }],
    integrations: [{ id: 'i1', doctor_id: DOC_A, gateway: 'whatsapp', external_id: 'pn-1', waba_id: 'waba-a', access_token: null }],
    whatsapp_templates: [],
  });
  db.setAuthUser('owner', { id: OWNER });
  db.setAuthUser('closer', { id: CLOSER });
});

describe('POST /integrations/whatsapp/templates/sync', () => {
  it('sem waba_id configurado -> 409 whatsapp_waba_not_configured', async () => {
    db.tables.integrations.find((i) => i.doctor_id === DOC_A).waba_id = null;
    mockGraphSinglePage([]);
    const res = await request(app).post('/integrations/whatsapp/templates/sync').set({ Authorization: 'Bearer owner' }).send({ doctor_id: DOC_A });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('whatsapp_waba_not_configured');
  });

  it('closer nunca sincroniza -> 403', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const res = await request(app).post('/integrations/whatsapp/templates/sync').set({ Authorization: 'Bearer closer' }).send({ doctor_id: DOC_A });
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('usa o token individual quando existe (não o de sistema)', async () => {
    db.tables.integrations.find((i) => i.doctor_id === DOC_A).access_token = 'individual-tok';
    let seenAuth = null;
    global.fetch = vi.fn(async (url, opts) => {
      seenAuth = opts?.headers?.Authorization;
      return { ok: true, json: async () => ({ data: [metaTemplate('t1')], paging: { cursors: {} } }) };
    });
    const res = await request(app).post('/integrations/whatsapp/templates/sync').set({ Authorization: 'Bearer owner' }).send({ doctor_id: DOC_A });
    expect(res.status).toBe(200);
    expect(seenAuth).toBe('Bearer individual-tok');
  });

  it('sem token individual, cai para META_SYSTEM_USER_TOKEN', async () => {
    let seenAuth = null;
    global.fetch = vi.fn(async (url, opts) => {
      seenAuth = opts?.headers?.Authorization;
      return { ok: true, json: async () => ({ data: [], paging: { cursors: {} } }) };
    });
    const res = await request(app).post('/integrations/whatsapp/templates/sync').set({ Authorization: 'Bearer owner' }).send({ doctor_id: DOC_A });
    expect(res.status).toBe(200);
    expect(seenAuth).toBe('Bearer system-fallback-token');
  });

  it('paginação completa: os dois templates das duas páginas entram no cache', async () => {
    let calls = 0;
    global.fetch = vi.fn(async (url) => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ data: [metaTemplate('t1')], paging: { cursors: { after: 'c1' }, next: 'x' } }) };
      return { ok: true, json: async () => ({ data: [metaTemplate('t2')], paging: { cursors: {} } }) };
    });
    const res = await request(app).post('/integrations/whatsapp/templates/sync').set({ Authorization: 'Bearer owner' }).send({ doctor_id: DOC_A });
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(2);
    expect(db.tables.whatsapp_templates.filter((t) => t.doctor_id === DOC_A)).toHaveLength(2);
  });

  it('cursor repetido nunca vira 500 disfarçado — 502 sanitizado, cache intocado', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: [metaTemplate('t1')], paging: { cursors: { after: 'same' }, next: 'x' } }) }));
    const res = await request(app).post('/integrations/whatsapp/templates/sync').set({ Authorization: 'Bearer owner' }).send({ doctor_id: DOC_A });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('whatsapp_template_sync_failed');
    expect(db.tables.whatsapp_templates).toHaveLength(0);
  });

  it('falha na página 2 não altera o cache existente', async () => {
    db.tables.whatsapp_templates.push({
      id: 'existing', doctor_id: DOC_A, meta_template_id: 'old', nome: 'antigo', idioma: 'pt_BR', status: 'APPROVED',
      body_text: 'Oi', body_variable_count: 0, supported: true, active: true, last_synced_at: new Date().toISOString(),
    });
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ data: [metaTemplate('t1')], paging: { cursors: { after: 'c1' }, next: 'x' } }) };
      return { ok: false, json: async () => ({ error: { message: 'temporary' } }) };
    });
    const res = await request(app).post('/integrations/whatsapp/templates/sync').set({ Authorization: 'Bearer owner' }).send({ doctor_id: DOC_A });
    expect(res.status).toBe(502);
    expect(db.tables.whatsapp_templates).toHaveLength(1);
    expect(db.tables.whatsapp_templates[0].meta_template_id).toBe('old'); // intocado
  });

  it('snapshot completo: template ausente na nova lista vira active=false, nunca é apagado', async () => {
    db.tables.whatsapp_templates.push({
      id: 'existing', doctor_id: DOC_A, meta_template_id: 'sumiu', nome: 'antigo', idioma: 'pt_BR', status: 'APPROVED',
      body_text: 'Oi', body_variable_count: 0, supported: true, active: true, last_synced_at: new Date(0).toISOString(),
    });
    mockGraphSinglePage([metaTemplate('novo')]);
    const res = await request(app).post('/integrations/whatsapp/templates/sync').set({ Authorization: 'Bearer owner' }).send({ doctor_id: DOC_A });
    expect(res.status).toBe(200);
    const sumiu = db.tables.whatsapp_templates.find((t) => t.meta_template_id === 'sumiu');
    expect(sumiu).toBeTruthy(); // nunca deletado
    expect(sumiu.active).toBe(false);
    const novo = db.tables.whatsapp_templates.find((t) => t.meta_template_id === 'novo');
    expect(novo.active).toBe(true);
  });

  it('isolamento entre médicos: sync do médico A nunca toca templates do médico B', async () => {
    db.tables.whatsapp_templates.push({
      id: 'b1', doctor_id: DOC_B, meta_template_id: 'de-outro-medico', nome: 'x', idioma: 'pt_BR', status: 'APPROVED',
      body_text: 'Oi', body_variable_count: 0, supported: true, active: true, last_synced_at: new Date().toISOString(),
    });
    mockGraphSinglePage([metaTemplate('t1')]);
    await request(app).post('/integrations/whatsapp/templates/sync').set({ Authorization: 'Bearer owner' }).send({ doctor_id: DOC_A });
    const ofB = db.tables.whatsapp_templates.find((t) => t.doctor_id === DOC_B);
    expect(ofB.active).toBe(true); // nunca desativado por um sync de outro médico
  });

  it('resposta nunca contém waba_id nem token', async () => {
    mockGraphSinglePage([metaTemplate('t1')]);
    const res = await request(app).post('/integrations/whatsapp/templates/sync').set({ Authorization: 'Bearer owner' }).send({ doctor_id: DOC_A });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/waba-a|system-fallback-token|individual-tok/);
  });
});

describe('GET /integrations/whatsapp/templates', () => {
  beforeEach(() => {
    db.tables.whatsapp_templates.push(
      { id: 'ok', doctor_id: DOC_A, meta_template_id: 'ok', nome: 'ok', idioma: 'pt_BR', status: 'APPROVED', body_text: 'Oi', body_variable_count: 0, supported: true, active: true, last_synced_at: new Date().toISOString() },
      { id: 'pend', doctor_id: DOC_A, meta_template_id: 'pend', nome: 'pend', idioma: 'pt_BR', status: 'PENDING', body_text: 'Oi', body_variable_count: 0, supported: true, active: true, last_synced_at: new Date().toISOString() },
      { id: 'unsup', doctor_id: DOC_A, meta_template_id: 'unsup', nome: 'unsup', idioma: 'pt_BR', status: 'APPROVED', body_text: 'Oi', body_variable_count: 0, supported: false, unsupported_reason: 'variavel_no_header', active: true, last_synced_at: new Date().toISOString() },
    );
  });

  it('só conta approved+active+supported no approved_count', async () => {
    const res = await request(app).get('/integrations/whatsapp/templates').query({ doctor_id: DOC_A }).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(200);
    expect(res.body.approved_count).toBe(1);
    expect(res.body.templates).toHaveLength(3); // todos aparecem na listagem completa (o seletor filtra no frontend)
  });

  it('nunca retorna waba_id, token nem componentes brutos', async () => {
    const res = await request(app).get('/integrations/whatsapp/templates').query({ doctor_id: DOC_A }).set({ Authorization: 'Bearer owner' });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/waba_id|componentes|access_token/);
  });
});
