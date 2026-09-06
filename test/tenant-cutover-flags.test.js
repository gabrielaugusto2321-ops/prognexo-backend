import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';
import { validateEnv } from '../src/config/env.js';

// FASE 2.9 — cutover: comportamento com as flags LIGADAS x DESLIGADAS.
// Prova que:
//  - nenhuma rota nova cai silenciosamente no doctor_id legado com a flag ON;
//  - com todas as flags OFF o comportamento legado é idêntico ao de antes.

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));
vi.mock('../src/lib/iaAgent.js', () => ({ processarMensagemComIA: vi.fn(async () => ({ resposta: 'ok', score: 1 })) }));
vi.mock('../src/lib/knowledgeChunks.js', () => ({ buscarChunksRelevantes: vi.fn(async () => []) }));

const U = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const DONO_A = U(1); // owner da Clínica A (org A), legado role 'doctor'
const MULTI = U(2);   // membership ativa em A e B
const SUSP = U(4);    // membership suspensa em A
const ORG_A = U('a');
const ORG_B = U('b');
const DOC_A = U('d');
const DOC_B = U('e');

function seed() {
  db = makeDb({
    users: [
      { id: DONO_A, role: 'doctor', ativo: true },
      { id: MULTI, role: 'closer', ativo: true },
      { id: SUSP, role: 'closer', ativo: true },
    ],
    doctors: [
      { id: DOC_A, owner_user_id: DONO_A },
      { id: DOC_B, owner_user_id: U(9) },
    ],
    organizations: [
      { id: ORG_A, name: 'Clínica A', status: 'active' },
      { id: ORG_B, name: 'Clínica B', status: 'active' },
    ],
    units: [
      { id: 'unitA', organization_id: ORG_A, name: 'Unidade A', status: 'active' },
    ],
    memberships: [
      { id: 'mDono', organization_id: ORG_A, user_id: DONO_A, role: 'organization_owner', status: 'active' },
      { id: 'mMultiA', organization_id: ORG_A, user_id: MULTI, role: 'closer', status: 'active' },
      { id: 'mMultiB', organization_id: ORG_B, user_id: MULTI, role: 'closer', status: 'active' },
      { id: 'mSusp', organization_id: ORG_A, user_id: SUSP, role: 'closer', status: 'suspended' },
    ],
    membership_units: [{ membership_id: 'mDono', unit_id: 'unitA' }, { membership_id: 'mMultiA', unit_id: 'unitA' }],
    platform_admins: [],
    organization_doctor_map: [
      { organization_id: ORG_A, doctor_id: DOC_A, default_unit_id: 'unitA' },
      { organization_id: ORG_B, doctor_id: DOC_B, default_unit_id: null },
    ],
    // DONO_A é dono do DOC_A no legado; no cutover também tem acesso legado ao DOC_B
    // (linha remanescente) — a flag ON precisa IGNORAR isso.
    user_doctor_access: [{ user_id: DONO_A, doctor_id: DOC_B }, { user_id: MULTI, doctor_id: DOC_A }, { user_id: MULTI, doctor_id: DOC_B }],
    leads: [
      { id: 'lA', doctor_id: DOC_A, organization_id: ORG_A, sdr_responsavel_id: MULTI, status_atual: 'lead', criado_em: new Date().toISOString() },
      { id: 'lB', doctor_id: DOC_B, organization_id: ORG_B, sdr_responsavel_id: MULTI, status_atual: 'lead', criado_em: new Date().toISOString() },
    ],
    integrations: [{ id: 'iA', doctor_id: DOC_A, gateway: 'whatsapp', organization_id: ORG_A }],
    conversations: [
      { id: 'cvA', lead_id: 'lA', doctor_id: DOC_A, organization_id: ORG_A, direcao: 'recebida', timestamp_msg: new Date().toISOString() },
      { id: 'cvB', lead_id: 'lB', doctor_id: DOC_B, organization_id: ORG_B, direcao: 'recebida', timestamp_msg: new Date().toISOString() },
    ],
    knowledge_base: [
      { id: 'kbA', doctor_id: DOC_A, organization_id: ORG_A, titulo: 'A', conteudo: 'x' },
      { id: 'kbB', doctor_id: DOC_B, organization_id: ORG_B, titulo: 'B', conteudo: 'y' },
    ],
  });
  db.setAuthUser('dono', { id: DONO_A });
  db.setAuthUser('multi', { id: MULTI });
  db.setAuthUser('susp', { id: SUSP });
}

const ALL_FLAGS_ON = {
  TENANT_CORE_ENABLED: 'true',
  TEAM_MEMBERSHIPS_ENABLED: 'true',
  TEAM_INVITE_OUTBOX_ENABLED: 'true',
  TEAM_INVITE_EMAIL_DELIVERY_ENABLED: 'false',
  TOKEN_ENCRYPTION_ENABLED: 'true',
  PERSISTENT_JOB_QUEUE_ENABLED: 'true',
  USAGE_QUOTAS_ENABLED: 'true',
  CAMPAIGN_JOB_QUEUE_ENABLED: 'true',
  TENANT_SHADOW_READ_ENABLED: 'true',
};

const CRYPTO_KEY = Buffer.alloc(32, 7).toString('base64');

async function app(flags) {
  vi.resetModules();
  for (const k of [...Object.keys(ALL_FLAGS_ON), 'TOKEN_ENCRYPTION_KEYRING', 'TOKEN_ENCRYPTION_ACTIVE_KEY', 'TOKEN_LOOKUP_HMAC_KEY', 'JOB_RUNNER_SECRET', 'RESEND_API_KEY']) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(flags || {})) process.env[k] = v;
  // material criptográfico / segredos exigidos pelas flags ligadas
  if (Object.values(flags || {}).includes('true')) {
    process.env.TOKEN_ENCRYPTION_KEYRING = JSON.stringify({ v1: CRYPTO_KEY });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY = 'v1';
    process.env.TOKEN_LOOKUP_HMAC_KEY = CRYPTO_KEY;
    process.env.JOB_RUNNER_SECRET = 'job-runner-secret';
  }
  const mod = await import('../src/server.js');
  return mod.createApp();
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('FASE 2.9 — boot com todas as flags ligadas', () => {
  it('validateEnv aceita a cadeia completa (com keyring + segredos)', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(() => validateEnv({
      NODE_ENV: 'production', APP_ENV: 'production',
      SUPABASE_URL: 'https://prod-abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'x',
      ANTHROPIC_API_KEY: 'x', META_APP_SECRET: 'x', META_SYSTEM_USER_TOKEN: 'x',
      WHATSAPP_VERIFY_TOKEN: 'x', VOYAGE_API_KEY: 'x', CRON_SECRET: 'x',
      FRONTEND_URL: 'https://app.prod.example', CORS_ALLOWED_ORIGINS: 'https://app.prod.example',
      CAPTCHA_ENABLED: 'true', CAPTCHA_SECRET: 'x', PRODUCTION_HOSTS: 'prod-abc.supabase.co,app.prod.example',
      RESEND_API_KEY: 'x', JOB_RUNNER_SECRET: 'x',
      TOKEN_ENCRYPTION_KEYRING: JSON.stringify({ v1: key }), TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1',
      TOKEN_LOOKUP_HMAC_KEY: key,
      ...ALL_FLAGS_ON,
    })).not.toThrow();
  });

  it('a cadeia quebrada derruba o boot (memberships sem tenant core)', () => {
    expect(() => validateEnv({
      NODE_ENV: 'development', APP_ENV: 'development',
      TEAM_MEMBERSHIPS_ENABLED: 'true',
    })).toThrow(/tenant flag chain/i);
  });
});

describe('FASE 2.9 — flags LIGADAS: sem fallback para doctor_id legado', () => {
  beforeEach(seed);

  it('GET /doctors escopa pelo organization_doctor_map, não por owner_user_id/user_doctor_access', async () => {
    // DONO_A: dono do DOC_A e com user_doctor_access ao DOC_B. Com a flag ON e
    // Org A selecionada, só pode ver DOC_A.
    const res = await request(await app(ALL_FLAGS_ON))
      .get('/doctors').set(bearer('dono')).set('X-Organization-Id', ORG_A);
    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.id)).toEqual([DOC_A]);
  });

  it('POST /playground/simular: doctor_id de outra organização -> 403', async () => {
    const res = await request(await app(ALL_FLAGS_ON))
      .post('/playground/simular').set(bearer('dono')).set('X-Organization-Id', ORG_A)
      .send({ doctor_id: DOC_B, historico: [{ direcao: 'recebida', conteudo: 'oi' }] });
    expect(res.status).toBe(403);
  });

  it('PATCH /leads/:id de outra organização -> 403/404 (authorizeResource tenant-aware)', async () => {
    const res = await request(await app(ALL_FLAGS_ON))
      .patch('/leads/lB').set(bearer('multi')).set('X-Organization-Id', ORG_A)
      .send({ status_atual: 'perdido' });
    expect([403, 404]).toContain(res.status);
  });

  it('usuário multi-org sem X-Organization-Id -> 409', async () => {
    const res = await request(await app(ALL_FLAGS_ON)).get('/doctors').set(bearer('multi'));
    expect(res.status).toBe(409);
  });

  it('membership suspensa -> 403', async () => {
    const res = await request(await app(ALL_FLAGS_ON)).get('/leads').set(bearer('susp'));
    expect(res.status).toBe(403);
  });

  it('GET /integrations com org sem organization_doctor_map -> 409 tenant_backfill_required', async () => {
    // remove o map da Org B; MULTI seleciona a Org B
    seed();
    db.tables.organization_doctor_map = db.tables.organization_doctor_map.filter((m) => m.organization_id !== ORG_B);
    const res = await request(await app(ALL_FLAGS_ON))
      .get('/integrations').set(bearer('multi')).set('X-Organization-Id', ORG_B);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tenant_backfill_required');
  });
});

describe('FASE 2.9 — flags DESLIGADAS: comportamento legado preservado', () => {
  beforeEach(seed);

  it('GET /doctors usa o escopo legado: doctor vê os próprios; closer vê via user_doctor_access', async () => {
    const rDoctor = await request(await app({})).get('/doctors').set(bearer('dono'));
    expect(rDoctor.status).toBe(200);
    expect(rDoctor.body.map((d) => d.id)).toEqual([DOC_A]); // owner_user_id

    const rCloser = await request(await app({})).get('/doctors').set(bearer('multi'));
    expect(rCloser.status).toBe(200);
    expect(rCloser.body.map((d) => d.id).sort()).toEqual([DOC_A, DOC_B].sort()); // user_doctor_access
  });

  it('GET /leads legado: sem 409/403 de tenant', async () => {
    const res = await request(await app({})).get('/leads').set(bearer('multi'));
    expect(res.status).toBe(200);
  });

  it('POST /playground/simular legado: doctor acessível via user_doctor_access -> não bloqueia por tenant', async () => {
    const res = await request(await app({}))
      .post('/playground/simular').set(bearer('multi'))
      .send({ doctor_id: DOC_B, historico: [{ direcao: 'recebida', conteudo: 'oi' }] });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(409);
  });

  it('X-Organization-Id é ignorado com a flag OFF', async () => {
    // 'multi' (closer) tem user_doctor_access aos dois doctors; mandar
    // X-Organization-Id=ORG_A não deve restringir nada com a flag OFF.
    const res = await request(await app({})).get('/doctors').set(bearer('multi')).set('X-Organization-Id', ORG_A);
    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.id).sort()).toEqual([DOC_A, DOC_B].sort());
  });
});

describe('FASE 2.9 — fluxos adicionais com flags LIGADAS (rastreabilidade)', () => {
  beforeEach(seed);

  it('fluxo 8 — GET /conversations escopa pela organização selecionada', async () => {
    const a = await app(ALL_FLAGS_ON);
    const rA = await request(a).get('/conversations').set(bearer('dono')).set('X-Organization-Id', ORG_A);
    expect(rA.status).toBe(200);
    expect(rA.body.every((g) => g.lead_id === 'lA')).toBe(true);
  });

  it('fluxo 9 — GET /knowledge-base: doctor da org selecionada OK, doctor de outra org -> 403', async () => {
    const a = await app(ALL_FLAGS_ON);
    const ok = await request(a).get('/knowledge-base').query({ doctor_id: DOC_A }).set(bearer('dono')).set('X-Organization-Id', ORG_A);
    expect(ok.status).toBe(200);
    const no = await request(a).get('/knowledge-base').query({ doctor_id: DOC_B }).set(bearer('dono')).set('X-Organization-Id', ORG_A);
    expect(no.status).toBe(403);
  });

  it('fluxo 20 — troca de organização na mesma sessão re-escopa os dados', async () => {
    const a = await app(ALL_FLAGS_ON);
    const rA = await request(a).get('/leads').set(bearer('multi')).set('X-Organization-Id', ORG_A);
    const rB = await request(a).get('/leads').set(bearer('multi')).set('X-Organization-Id', ORG_B);
    expect(rA.status).toBe(200);
    expect(rB.status).toBe(200);
    expect(rA.body.map((l) => l.id)).toEqual(['lA']);
    expect(rB.body.map((l) => l.id)).toEqual(['lB']);
  });
});
