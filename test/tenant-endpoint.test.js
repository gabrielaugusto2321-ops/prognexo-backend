import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// FASE 2.3 — GET /tenant/context + propagação/validação de X-Unit-Id.

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));

const U = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const SOLO = U(1); // 1 organização
const MULTI = U(2); // 2 organizações
const NOBODY = U(3); // 0 memberships
const SUSPENSO = U(4); // membership suspensa
const ORG_A = U('a');
const ORG_B = U('b');
const DOC_A = U('d');

function seed() {
  db = makeDb({
    users: [
      { id: SOLO, role: 'closer', ativo: true },
      { id: MULTI, role: 'closer', ativo: true },
      { id: NOBODY, role: 'closer', ativo: true },
      { id: SUSPENSO, role: 'closer', ativo: true },
    ],
    doctors: [{ id: DOC_A, owner_user_id: SOLO }],
    organizations: [
      { id: ORG_A, name: 'Clínica A', status: 'active' },
      { id: ORG_B, name: 'Clínica B', status: 'active' },
    ],
    units: [
      { id: 'unitA', organization_id: ORG_A, name: 'Unidade A', status: 'active' },
      { id: 'unitB', organization_id: ORG_B, name: 'Unidade B', status: 'active' },
    ],
    memberships: [
      { id: 'mSolo', organization_id: ORG_A, user_id: SOLO, role: 'organization_owner', status: 'active' },
      { id: 'mMultiA', organization_id: ORG_A, user_id: MULTI, role: 'closer', status: 'active' },
      { id: 'mMultiB', organization_id: ORG_B, user_id: MULTI, role: 'closer', status: 'active' },
      { id: 'mSusp', organization_id: ORG_A, user_id: SUSPENSO, role: 'closer', status: 'suspended' },
    ],
    membership_units: [
      { membership_id: 'mSolo', unit_id: 'unitA' },
      { membership_id: 'mMultiA', unit_id: 'unitA' },
      { membership_id: 'mMultiB', unit_id: 'unitB' },
    ],
    platform_admins: [],
    organization_doctor_map: [
      { organization_id: ORG_A, doctor_id: DOC_A, default_unit_id: 'unitA' },
      { organization_id: ORG_B, doctor_id: U('e'), default_unit_id: 'unitB' },
    ],
    leads: [
      { id: 'lA', doctor_id: DOC_A, organization_id: ORG_A, status_atual: 'lead', criado_em: new Date().toISOString() },
      // lead da Org B, com MULTI como responsável. MULTI tem acesso legado
      // (user_doctor_access) ao doctor da Org B — FASE 2.9 fecha esse fallback:
      // com Org A selecionada, authorizeResource escopa só ao doctor da Org A.
      { id: 'lB', doctor_id: U('e'), organization_id: ORG_B, sdr_responsavel_id: MULTI, status_atual: 'lead', telefone: '551100', criado_em: new Date().toISOString() },
    ],
    user_doctor_access: [
      { user_id: MULTI, doctor_id: DOC_A },
      { user_id: MULTI, doctor_id: U('e') },
    ],
    conversations: [{ lead_id: 'lB', direcao: 'recebida', timestamp_msg: new Date().toISOString() }],
    integrations: [{ doctor_id: U('e'), gateway: 'whatsapp', external_id: 'pn-B', access_token: 'tok' }],
  });
  db.setAuthUser('solo', { id: SOLO });
  db.setAuthUser('multi', { id: MULTI });
  db.setAuthUser('nobody', { id: NOBODY });
  db.setAuthUser('suspenso', { id: SUSPENSO });
}

async function app(flag) {
  vi.resetModules();
  process.env.TENANT_CORE_ENABLED = flag;
  const mod = await import('../src/server.js');
  return mod.createApp();
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('GET /tenant/context', () => {
  beforeEach(seed);

  it('uma organização: retorna 1 org + sugestão, requires_selection=false', async () => {
    const res = await request(await app('false')).get('/tenant/context').set(bearer('solo'));
    expect(res.status).toBe(200);
    expect(res.body.organizations).toHaveLength(1);
    expect(res.body.organizations[0]).toMatchObject({ id: ORG_A, name: 'Clínica A', role: 'organization_owner' });
    expect(res.body.organizations[0].units).toEqual([{ id: 'unitA', name: 'Unidade A' }]);
    expect(res.body.requires_selection).toBe(false);
    expect(res.body.suggested_organization_id).toBe(ORG_A);
  });

  it('múltiplas organizações: requires_selection=true, sem sugestão', async () => {
    const res = await request(await app('false')).get('/tenant/context').set(bearer('multi'));
    expect(res.status).toBe(200);
    expect(res.body.organizations.map((o) => o.id).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(res.body.requires_selection).toBe(true);
    expect(res.body.suggested_organization_id).toBeNull();
  });

  it('sem membership: lista vazia', async () => {
    const res = await request(await app('false')).get('/tenant/context').set(bearer('nobody'));
    expect(res.status).toBe(200);
    expect(res.body.organizations).toHaveLength(0);
    expect(res.body.requires_selection).toBe(false);
  });

  it('membership suspensa não concede acesso — não aparece', async () => {
    const res = await request(await app('false')).get('/tenant/context').set(bearer('suspenso'));
    expect(res.status).toBe(200);
    expect(res.body.organizations).toHaveLength(0);
  });

  it('não devolve tokens/segredos nem dados de outra organização', async () => {
    const res = await request(await app('false')).get('/tenant/context').set(bearer('solo'));
    const blob = JSON.stringify(res.body);
    expect(blob).not.toMatch(/token|secret|access_token|webhook/i);
    expect(blob).not.toContain(ORG_B); // SOLO não é membro da B
  });
});

describe('X-Unit-Id — propagação e validação (flag on)', () => {
  beforeEach(seed);

  it('MULTI seleciona Org A + unidade da Org A -> 200', async () => {
    const res = await request(await app('true'))
      .get('/leads')
      .set(bearer('multi'))
      .set('X-Organization-Id', ORG_A)
      .set('X-Unit-Id', 'unitA');
    expect(res.status).toBe(200);
  });

  it('X-Unit-Id de OUTRA organização -> 403 unit_not_in_organization', async () => {
    const res = await request(await app('true'))
      .get('/leads')
      .set(bearer('multi'))
      .set('X-Organization-Id', ORG_A)
      .set('X-Unit-Id', 'unitB');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unit_not_in_organization');
  });

  it('X-Unit-Id sem organização resolvível -> 409', async () => {
    const res = await request(await app('true')).get('/leads').set(bearer('multi')).set('X-Unit-Id', 'unitA');
    // MULTI tem 2 orgs e não mandou X-Organization-Id -> 409 organization_selection_required vem primeiro
    expect(res.status).toBe(409);
  });

  it('flag off: X-Unit-Id é ignorado, comportamento legado', async () => {
    const res = await request(await app('false')).get('/leads').set(bearer('solo')).set('X-Unit-Id', 'unitB');
    expect(res.status).toBe(200);
  });

  it('flag on: enviar mensagem para lead de OUTRA organização -> 403 antes do envio', async () => {
    const send = vi.fn(async () => ({}));
    vi.doMock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage: send }));
    const a = await app('true');
    const res = await request(a)
      .post('/conversations/send')
      .set(bearer('multi'))
      .set('X-Organization-Id', ORG_A) // seleciona Org A
      .send({ lead_id: 'lB', texto: 'oi' }); // lead está na Org B
    expect(res.status).toBe(403);
    // FASE 2.9: authorizeResource agora escopa pelo contexto de tenant e barra
    // o cross-tenant como 'forbidden' antes mesmo do check de organização do
    // lead (que continua como defesa em profundidade -> 'lead_fora_da_organizacao').
    expect(['forbidden', 'lead_fora_da_organizacao']).toContain(res.body.error);
    expect(send).not.toHaveBeenCalled();
    vi.doUnmock('../src/lib/whatsapp.js');
  });
});
