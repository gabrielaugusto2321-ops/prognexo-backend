import { describe, it, expect, vi } from 'vitest';
import { runReadiness, MAX_IDS } from '../scripts/check-tenant-cutover-readiness.js';

const LOCAL = 'http://127.0.0.1:54321';
const REMOTE = 'https://stg-abc.supabase.co';
const stagingEnv = { ALLOW_REMOTE_STAGING_READ: 'true', PRODUCTION_HOSTS: 'app.prod.example', STAGING_SUPABASE_PROJECT_REF: 'stg-abc' };

// Fake Supabase: builder chainável só-leitura sobre um mapa de tabelas.
// Um writeSpy garante que nenhum método de escrita é chamado.
function fakeClient(tables) {
  const writeSpy = vi.fn();
  function makeQuery(rows) {
    const filters = [];
    let head = false;
    let limit;
    const q = {
      select(_c, opts) { head = !!opts?.head; return this; },
      is(col, val) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; },
      eq(col, val) { filters.push((r) => r[col] === val); return this; },
      in(col, arr) { filters.push((r) => arr.includes(r[col])); return this; },
      lt(col, val) { filters.push((r) => r[col] != null && r[col] < val); return this; },
      gte(col, val) { filters.push((r) => r[col] != null && r[col] >= val); return this; },
      or(expr) {
        // suporta só "a.not.is.null,b.not.is.null" (usado em tokens_plaintext)
        const cols = expr.split(',').map((s) => s.split('.')[0]);
        filters.push((r) => cols.some((col) => r[col] != null));
        return this;
      },
      order() { return this; },
      limit(n) { limit = n; return this; },
      insert(...a) { writeSpy('insert', ...a); return this; },
      update(...a) { writeSpy('update', ...a); return this; },
      delete(...a) { writeSpy('delete', ...a); return this; },
      upsert(...a) { writeSpy('upsert', ...a); return this; },
      then(resolve) {
        const filtered = rows.filter((r) => filters.every((f) => f(r)));
        if (head) return resolve({ count: filtered.length, error: null });
        return resolve({ data: limit ? filtered.slice(0, limit) : filtered, error: null });
      },
    };
    return q;
  }
  function missingTableQuery(name) {
    const err = { message: `relation "${name}" does not exist`, code: '42P01' };
    const q = {
      select() { return this; }, is() { return this; }, eq() { return this; }, in() { return this; },
      lt() { return this; }, gte() { return this; }, or() { return this; }, order() { return this; }, limit() { return this; },
      then(resolve) { return resolve({ data: null, count: null, error: err }); },
    };
    return q;
  }
  const client = {
    from(name) {
      if (!(name in tables)) return missingTableQuery(name);
      return makeQuery(tables[name]);
    },
    rpc(...a) { writeSpy('rpc', ...a); return Promise.resolve({ data: null, error: null }); },
  };
  return { client, writeSpy };
}

// Base "tudo pronto": nenhuma pendência.
function cleanTables() {
  return {
    leads: [{ id: 'l1', organization_id: 'o1' }],
    events: [{ id: 'e1', organization_id: 'o1' }],
    campanhas: [{ id: 'c1', organization_id: 'o1' }],
    integrations: [{ id: 'i1', organization_id: 'o1', access_token: null, webhook_token: null }],
    conversations: [{ id: 'cv1', organization_id: 'o1' }],
    transactions: [{ id: 't1', organization_id: 'o1' }],
    atendimentos: [{ id: 'a1', organization_id: 'o1' }],
    knowledge_base: [{ id: 'k1', organization_id: 'o1' }],
    doctors: [{ id: 'd1' }],
    organization_doctor_map: [{ doctor_id: 'd1', organization_id: 'o1' }],
    users: [{ id: 'u1', ativo: true }],
    memberships: [{ id: 'm1', user_id: 'u1', organization_id: 'o1', status: 'active' }],
    platform_admins: [],
    membership_units: [{ membership_id: 'm1' }],
    units: [{ organization_id: 'o1', status: 'active' }],
    user_doctor_access: [{ user_id: 'u1', doctor_id: 'd1' }],
    organization_invitations: [],
    outbox_events: [],
    job_queue: [],
    usage_reservations: [],
  };
}

describe('runReadiness — guarda de ambiente', () => {
  it('production -> exit 1', async () => {
    const { client } = fakeClient(cleanTables());
    expect((await runReadiness({ client, appEnv: 'production', supabaseUrl: LOCAL })).code).toBe(1);
  });
  it('development + host remoto -> exit 1', async () => {
    const { client, writeSpy } = fakeClient(cleanTables());
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: REMOTE });
    expect(r.code).toBe(1);
    expect(writeSpy).not.toHaveBeenCalled();
  });
  it('staging remoto sem confirmação -> exit 1', async () => {
    const { client } = fakeClient(cleanTables());
    const r = await runReadiness({ client, appEnv: 'staging', supabaseUrl: REMOTE, env: { PRODUCTION_HOSTS: 'x', STAGING_SUPABASE_PROJECT_REF: 'stg-abc' } });
    expect(r.code).toBe(1);
  });
});

describe('runReadiness — checagens', () => {
  it('development + localhost + tudo pronto -> exit 0, sem escrita', async () => {
    const { client, writeSpy } = fakeClient(cleanTables());
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: LOCAL });
    expect(r.code).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.results.every((x) => !x.error && x.count === 0)).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('leads/conversations sem organização -> exit 2, só ids técnicos', async () => {
    const t = cleanTables();
    t.leads.push({ id: 'l2', organization_id: null }, { id: 'l3', organization_id: null });
    t.conversations.push({ id: 'cv2', organization_id: null });
    const { client, writeSpy } = fakeClient(t);
    const r = await runReadiness({ client, appEnv: 'staging', supabaseUrl: REMOTE, env: stagingEnv });
    expect(r.code).toBe(2);
    const leadsCheck = r.results.find((x) => x.key === 'leads_sem_organizacao');
    expect(leadsCheck.count).toBe(2);
    expect(leadsCheck.ids).toEqual(['l2', 'l3']);
    // a saída só carrega ids técnicos + contagens + labels estáticos: nenhum
    // objeto de linha, nenhum campo de PII, nenhuma URL/chave.
    const idPayload = JSON.stringify((r.results || []).map((x) => x.ids));
    expect(idPayload).not.toMatch(/telefone|mensagem|@|supabase\.co/i);
    for (const res of r.results) expect(res).not.toHaveProperty('rows');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('doctor sem organization_doctor_map -> pendência', async () => {
    const t = cleanTables();
    t.doctors.push({ id: 'd2' });
    const { client } = fakeClient(t);
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: LOCAL });
    const check = r.results.find((x) => x.key === 'doctors_sem_map');
    expect(check.count).toBe(1);
    expect(check.ids).toEqual(['d2']);
  });

  it('multi-org = AVISO (não bloqueia); usuário sem membership = BLOQUEADOR (exit 2)', async () => {
    const t = cleanTables();
    t.users.push({ id: 'u2', ativo: true }, { id: 'u3', ativo: true });
    t.memberships.push(
      { id: 'm2', user_id: 'u2', organization_id: 'o1', status: 'active' },
      { id: 'm3', user_id: 'u2', organization_id: 'o2', status: 'active' },
    );
    const { client } = fakeClient(t);
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: LOCAL });
    const multi = r.results.find((x) => x.key === 'usuarios_multi_org');
    expect(multi.ids).toEqual(['u2']);
    expect(multi.severity).toBe('warning');
    expect(r.warnings.map((w) => w.key)).toContain('usuarios_multi_org');
    const orfao = r.results.find((x) => x.key === 'usuarios_sem_membership_ativa');
    expect(orfao.ids).toEqual(['u3']);
    expect(orfao.severity).toBe('blocker');
    expect(r.code).toBe(2); // o bloqueador manda
  });

  it('SÓ multi-org pendente (nenhum bloqueador) -> exit 0 com aviso', async () => {
    const t = cleanTables();
    t.users.push({ id: 'u2', ativo: true });
    t.memberships.push(
      { id: 'm2', user_id: 'u2', organization_id: 'o1', status: 'active' },
      { id: 'm3', user_id: 'u2', organization_id: 'o2', status: 'active' },
    );
    // u2 precisa de unidade nas duas orgs para não disparar memberships_sem_unidade
    t.membership_units.push({ membership_id: 'm2' }, { membership_id: 'm3' });
    t.units.push({ organization_id: 'o2', status: 'active' });
    const { client } = fakeClient(t);
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: LOCAL });
    expect(r.code).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.key)).toEqual(['usuarios_multi_org']);
  });

  it('platform_admin sem membership NÃO é pendência', async () => {
    const t = cleanTables();
    t.users.push({ id: 'padm', ativo: true });
    t.platform_admins.push({ user_id: 'padm' });
    const { client } = fakeClient(t);
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: LOCAL });
    expect(r.results.find((x) => x.key === 'usuarios_sem_membership_ativa').count).toBe(0);
  });

  it('divergência user_doctor_access x memberships -> pendência com par user:doctor', async () => {
    const t = cleanTables();
    t.user_doctor_access.push({ user_id: 'uX', doctor_id: 'd1' }); // uX não tem membership ativa em o1
    const { client } = fakeClient(t);
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: LOCAL });
    const check = r.results.find((x) => x.key === 'divergencia_user_doctor_access_vs_memberships');
    expect(check.count).toBe(1);
    expect(check.ids).toEqual(['uX:d1']);
  });

  it('token plaintext restante -> pendência', async () => {
    const t = cleanTables();
    t.integrations.push({ id: 'i2', organization_id: 'o1', access_token: 'algum-valor', webhook_token: null });
    const { client } = fakeClient(t);
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: LOCAL });
    const check = r.results.find((x) => x.key === 'tokens_plaintext_restantes');
    expect(check.count).toBe(1);
    expect(check.ids).toEqual(['i2']);
    // valor do token nunca aparece na saída
    expect(JSON.stringify(r)).not.toMatch(/algum-valor/);
  });

  it('job em dead_letter -> pendência', async () => {
    const t = cleanTables();
    t.job_queue.push({ id: 'j1', status: 'dead_letter', created_at: new Date().toISOString() });
    const { client } = fakeClient(t);
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: LOCAL });
    expect(r.results.find((x) => x.key === 'jobs_presos').count).toBe(1);
  });

  it('tabela ausente (migration não aplicada) -> checagem com erro, exit 1, sem abortar as outras', async () => {
    const t = cleanTables();
    delete t.usage_reservations;
    const { client } = fakeClient(t);
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: LOCAL });
    expect(r.code).toBe(1);
    const check = r.results.find((x) => x.key === 'reservas_de_quota_orfas');
    expect(check.error).toBeTruthy();
    // as outras checagens ainda rodaram
    expect(r.results.length).toBeGreaterThan(10);
  });

  it('truncamento em MAX_IDS', async () => {
    const t = cleanTables();
    for (let i = 0; i < MAX_IDS + 10; i++) t.leads.push({ id: `x${i}`, organization_id: null });
    const { client } = fakeClient(t);
    const r = await runReadiness({ client, appEnv: 'development', supabaseUrl: LOCAL });
    const check = r.results.find((x) => x.key === 'leads_sem_organizacao');
    expect(check.count).toBe(MAX_IDS + 10);
    expect(check.ids.length).toBe(MAX_IDS);
    expect(check.truncated).toBe(true);
  });
});
