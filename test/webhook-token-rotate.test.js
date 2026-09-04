import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// FASE 2.4 — POST /integrations/:id/webhook-token/rotate

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));

const U = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const OWNER_A = U(1);
const ADMIN_A = U(2);
const CLOSER_A = U(3);
const OWNER_B = U(4);
const ORG_A = U('a');
const ORG_B = U('b');
const DOC_A = U('d');
const DOC_B = U('e');
const INTEG_A = 'integ-a-pagarme';
const INTEG_B = 'integ-b-pagarme';

function seed() {
  db = makeDb({
    users: [
      { id: OWNER_A, role: 'doctor', ativo: true },
      { id: ADMIN_A, role: 'closer', ativo: true },
      { id: CLOSER_A, role: 'closer', ativo: true },
      { id: OWNER_B, role: 'doctor', ativo: true },
    ],
    doctors: [{ id: DOC_A, owner_user_id: OWNER_A }, { id: DOC_B, owner_user_id: OWNER_B }],
    organizations: [
      { id: ORG_A, name: 'A', status: 'active' },
      { id: ORG_B, name: 'B', status: 'active' },
    ],
    units: [{ id: 'unitA', organization_id: ORG_A }],
    memberships: [
      { id: 'm1', organization_id: ORG_A, user_id: OWNER_A, role: 'organization_owner', status: 'active' },
      { id: 'm2', organization_id: ORG_A, user_id: ADMIN_A, role: 'organization_admin', status: 'active' },
      { id: 'm3', organization_id: ORG_A, user_id: CLOSER_A, role: 'closer', status: 'active' },
      { id: 'm4', organization_id: ORG_B, user_id: OWNER_B, role: 'organization_owner', status: 'active' },
    ],
    membership_units: [{ membership_id: 'm1', unit_id: 'unitA' }],
    platform_admins: [],
    organization_doctor_map: [
      { organization_id: ORG_A, doctor_id: DOC_A, default_unit_id: 'unitA' },
      { organization_id: ORG_B, doctor_id: DOC_B, default_unit_id: null },
    ],
    integrations: [
      { id: INTEG_A, doctor_id: DOC_A, organization_id: ORG_A, gateway: 'pagarme', webhook_token: 'old-token-A', webhook_token_rotated_at: null, webhook_token_fingerprint: null },
      { id: INTEG_B, doctor_id: DOC_B, organization_id: ORG_B, gateway: 'pagarme', webhook_token: 'old-token-B', webhook_token_rotated_at: null, webhook_token_fingerprint: null },
      { id: 'integ-a-whatsapp', doctor_id: DOC_A, organization_id: ORG_A, gateway: 'whatsapp', external_id: 'pn-A' },
    ],
    webhook_token_events: [],
  });
  db.setAuthUser('ownerA', { id: OWNER_A });
  db.setAuthUser('adminA', { id: ADMIN_A });
  db.setAuthUser('closerA', { id: CLOSER_A });
  db.setAuthUser('ownerB', { id: OWNER_B });
}

async function app(flag) {
  vi.resetModules();
  process.env.TENANT_CORE_ENABLED = flag;
  const mod = await import('../src/server.js');
  return { app: mod.createApp(), resolveDoctorFromToken: (await import('../src/lib/salesWebhook.js')).resolveDoctorFromToken };
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const rotate = (a, id, tok, body) => request(a).post(`/integrations/${id}/webhook-token/rotate`).set(bearer(tok)).send(body ?? { confirm: true });

describe('POST /integrations/:id/webhook-token/rotate (flag on)', () => {
  beforeEach(seed);

  it('organization_owner rotaciona -> 200 com token novo (>=32 bytes base64url)', async () => {
    const { app: a } = await app('true');
    const res = await rotate(a, INTEG_A, 'ownerA');
    expect(res.status).toBe(200);
    expect(res.body.webhook_token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(res.body.webhook_token_fingerprint).toMatch(/^[a-f0-9]{12}$/);
    expect(res.body.webhook_url).toBe('/webhooks/pagarme');
    expect(res.body.header).toBe('X-Prognexo-Webhook-Token');
  });

  it('organization_admin também pode rotacionar', async () => {
    const { app: a } = await app('true');
    expect((await rotate(a, INTEG_A, 'adminA')).status).toBe(200);
  });

  it('closer NÃO pode rotacionar -> 403', async () => {
    const { app: a } = await app('true');
    const res = await rotate(a, INTEG_A, 'closerA');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('integração de outra organização -> 404 (sem enumeração)', async () => {
    const { app: a } = await app('true');
    const res = await rotate(a, INTEG_B, 'ownerA');
    expect(res.status).toBe(404);
  });

  it('gateway whatsapp -> 400 not_applicable (Meta intocada)', async () => {
    const { app: a } = await app('true');
    const res = await rotate(a, 'integ-a-whatsapp', 'ownerA');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not_applicable_for_whatsapp');
    // nenhuma escrita na integração de whatsapp
    expect(db.tables.integrations.find((i) => i.id === 'integ-a-whatsapp').webhook_token_rotated_at).toBeUndefined();
    expect(db.tables.webhook_token_events).toHaveLength(0);
  });

  it('confirmação ausente -> 400', async () => {
    const { app: a } = await app('true');
    expect((await rotate(a, INTEG_A, 'ownerA', {})).status).toBe(400);
    expect((await rotate(a, INTEG_A, 'ownerA', { confirm: false })).status).toBe(400);
  });

  it('body com token escolhido / organization_id / role -> 400 (schema strict)', async () => {
    const { app: a } = await app('true');
    expect((await rotate(a, INTEG_A, 'ownerA', { confirm: true, webhook_token: 'meu' })).status).toBe(400);
    expect((await rotate(a, INTEG_A, 'ownerA', { confirm: true, organization_id: ORG_B })).status).toBe(400);
    expect((await rotate(a, INTEG_A, 'ownerA', { confirm: true, role: 'platform_admin' })).status).toBe(400);
    expect((await rotate(a, INTEG_A, 'ownerA', { confirm: true, doctor_id: DOC_B })).status).toBe(400);
  });

  it('dois tokens gerados são diferentes; o anterior deixa de resolver; o novo resolve só a integração certa', async () => {
    const { app: a, resolveDoctorFromToken } = await app('true');
    const r1 = await rotate(a, INTEG_A, 'ownerA');
    expect(await resolveDoctorFromToken('pagarme', 'old-token-A')).toBe(null); // anterior morto
    expect(await resolveDoctorFromToken('pagarme', r1.body.webhook_token)).toBe(DOC_A); // novo resolve
    // avança o relógio além da janela de dedup e rotaciona de novo
    db.tables.integrations.find((i) => i.id === INTEG_A).webhook_token_rotated_at = new Date(Date.now() - 60_000).toISOString();
    const r2 = await rotate(a, INTEG_A, 'ownerA');
    expect(r2.body.webhook_token).not.toBe(r1.body.webhook_token);
    expect(await resolveDoctorFromToken('pagarme', r1.body.webhook_token)).toBe(null); // r1 agora morto
    expect(await resolveDoctorFromToken('whatsapp', r2.body.webhook_token)).toBe(null); // não cruza gateway
  });

  it('clique/requisição duplicada dentro da janela -> 409 rotation_too_recent, sem novo token', async () => {
    const { app: a } = await app('true');
    const r1 = await rotate(a, INTEG_A, 'ownerA');
    const r2 = await rotate(a, INTEG_A, 'ownerA');
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('rotation_too_recent');
    expect(r2.body.webhook_token).toBeUndefined();
    expect(r2.body.webhook_token_fingerprint).toBe(r1.body.webhook_token_fingerprint);
  });

  it('GET /integrations depois NÃO contém o token (só fingerprint + configurado)', async () => {
    const { app: a } = await app('true');
    await rotate(a, INTEG_A, 'ownerA');
    const res = await request(a).get('/integrations').set(bearer('ownerA'));
    const blob = JSON.stringify(res.body);
    expect(blob).not.toMatch(/"webhook_token"\s*:/);
    expect(blob).not.toMatch(/[A-Za-z0-9_-]{43}/); // nenhum token base64url solto
    const row = (res.body || []).find((r) => r.gateway === 'pagarme');
    expect(row?.webhook_token_configurado).toBe(true);
    expect(row?.webhook_token_fingerprint).toMatch(/^[a-f0-9]{12}$/);
  });

  it('auditoria: webhook_token_events registra sucesso SEM o token', async () => {
    const { app: a } = await app('true');
    await rotate(a, INTEG_A, 'ownerA');
    const ev = db.tables.webhook_token_events;
    expect(ev.length).toBe(1);
    expect(ev[0]).toMatchObject({ integration_id: INTEG_A, organization_id: ORG_A, actor_user_id: OWNER_A, action: 'rotate', result: 'success' });
    expect(JSON.stringify(ev[0])).not.toMatch(/[A-Za-z0-9_-]{43}/); // sem token
  });

  it('CAS: estado muda entre a leitura e o UPDATE -> 409 rotation_conflict, sem token, audit "conflict"', async () => {
    const { app: a, resolveDoctorFromToken } = await app('true');
    // rotated_at 60s atrás -> passa da janela de dedup; força o caminho do CAS
    const row0 = db.tables.integrations.find((i) => i.id === INTEG_A);
    row0.webhook_token_rotated_at = new Date(Date.now() - 60_000).toISOString();
    row0.webhook_token_fingerprint = 'aaaaaaaaaaaa';

    // intercepta: na 2ª chamada a .from('integrations') (o UPDATE do CAS),
    // um "concorrente" já rotacionou -> o WHERE do CAS não casa mais.
    const orig = db.client.from.bind(db.client);
    let integCalls = 0;
    db.client.from = (n) => {
      if (n === 'integrations') {
        integCalls += 1;
        if (integCalls === 2) {
          const r = db.tables.integrations.find((i) => i.id === INTEG_A);
          r.webhook_token_rotated_at = new Date().toISOString();
          r.webhook_token_fingerprint = 'bbbbbbbbbbbb';
          r.webhook_token = 'winner-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
        }
      }
      return orig(n);
    };

    const res = await rotate(a, INTEG_A, 'ownerA');
    db.client.from = orig;

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('rotation_conflict');
    expect(res.body.webhook_token).toBeUndefined(); // token perdedor NUNCA sai
    expect(res.body.webhook_token_fingerprint).toBe('bbbbbbbbbbbb'); // estado seguro do vencedor
    // o token perdedor não foi persistido -> só resolve o do "concorrente"
    expect(await resolveDoctorFromToken('pagarme', 'winner-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).toBe(DOC_A);
    // auditoria: exatamente 1 evento 'conflict', sem token
    const evs = db.tables.webhook_token_events.filter((e) => e.integration_id === INTEG_A);
    expect(evs.map((e) => e.result)).toEqual(['conflict']);
    expect(JSON.stringify(evs)).not.toMatch(/winner-token|[A-Za-z0-9_-]{43}/);
  });

  it('CONCORRÊNCIA (Promise.all): exatamente uma 200 e uma 409; a 409 nunca traz o token', async () => {
    const { app: a } = await app('true');
    db.tables.integrations.find((i) => i.id === INTEG_A).webhook_token_rotated_at = new Date(Date.now() - 60_000).toISOString();
    const [r1, r2] = await Promise.all([rotate(a, INTEG_A, 'ownerA'), rotate(a, INTEG_A, 'ownerA')]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const conflict = r1.status === 409 ? r1 : r2;
    expect([409]).toContain(conflict.status);
    expect(conflict.body.webhook_token).toBeUndefined();
    expect(['rotation_conflict', 'rotation_too_recent']).toContain(conflict.body.error);
    // um único estado final
    const winner = (r1.status === 200 ? r1 : r2).body;
    expect(db.tables.integrations.find((i) => i.id === INTEG_A).webhook_token_fingerprint).toBe(winner.webhook_token_fingerprint);
  });

  it('CONCORRÊNCIA: integrações diferentes rotacionam simultaneamente sem bloqueio', async () => {
    // adiciona uma 2ª integração de pagamento na Org A
    db.tables.integrations.push({ id: 'integ-a-kiwify', doctor_id: DOC_A, organization_id: ORG_A, gateway: 'kiwify', webhook_token: 'old-k-A', webhook_token_rotated_at: null, webhook_token_fingerprint: null });
    const { app: a } = await app('true');
    const [r1, r2] = await Promise.all([rotate(a, INTEG_A, 'ownerA'), rotate(a, 'integ-a-kiwify', 'ownerA')]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.webhook_token).not.toBe(r2.body.webhook_token);
  });

  it('rate-limit: 6ª rotação no minuto -> 429', async () => {
    const { app: a } = await app('true');
    // usa integrações diferentes / avança relógio para não bater no dedup
    for (let i = 0; i < 5; i++) {
      db.tables.integrations.find((x) => x.id === INTEG_A).webhook_token_rotated_at = new Date(Date.now() - 60_000).toISOString();
      const r = await rotate(a, INTEG_A, 'ownerA');
      expect([200, 409]).toContain(r.status);
    }
    db.tables.integrations.find((x) => x.id === INTEG_A).webhook_token_rotated_at = new Date(Date.now() - 60_000).toISOString();
    const r6 = await rotate(a, INTEG_A, 'ownerA');
    expect(r6.status).toBe(429);
  });
});

describe('rotate — flag off (compat legado)', () => {
  beforeEach(seed);
  it('doctor dono rotaciona; outro doctor -> 404', async () => {
    const { app: a } = await app('false');
    // sem tenant context: resolveDoctorId(doctor role) busca doctors.owner_user_id
    const ok = await rotate(a, INTEG_A, 'ownerA');
    expect(ok.status).toBe(200);
    db.tables.integrations.find((x) => x.id === INTEG_A).webhook_token_rotated_at = new Date(Date.now() - 60_000).toISOString();
    const cross = await rotate(a, INTEG_B, 'ownerA');
    expect(cross.status).toBe(404);
  });
});
