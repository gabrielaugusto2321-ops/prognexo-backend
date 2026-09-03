import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// FASE 2.2 — RLS real das colunas de token/ciphertext (migration 0009 aplicada).
// Sem service_role.
// Rodar: SUPABASE_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run test/rls

const DB_URL = process.env.SUPABASE_TEST_DB_URL;
let pg;
try {
  pg = (await import('pg')).default;
} catch {
  pg = null;
}
const d = DB_URL && pg ? describe : describe.skip;

const A_OWNER = '00000000-0000-4000-8000-00000000a001';
const B_OWNER = '00000000-0000-4000-8000-00000000b001';
const PLAT_ADMIN = '00000000-0000-4000-8000-00000000ad01';
const NOBODY = '00000000-0000-4000-8000-00000000dead';
const DOC_A = '00000000-0000-4000-8000-0000000000da';

let pool;

async function withRole(role, sub, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [sub ? JSON.stringify({ sub, role: 'authenticated' }) : '']);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}
const asUser = (sub, fn) => withRole('authenticated', sub, fn);
async function deniedAs(role, sub, sql) {
  await expect(withRole(role, sub, (c) => c.query(sql))).rejects.toThrow(/permission denied|row-level security|violates/i);
}

d('RLS — token encryption (0009) — Supabase local', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('colunas novas existem e têm as constraints de formato', async () => {
    const su = await pool.connect();
    try {
      const cols = await su.query(
        "select column_name from information_schema.columns where table_name='integrations' and column_name like '%encrypted%' or (table_name='integrations' and column_name='webhook_token_lookup')"
      );
      const names = cols.rows.map((r) => r.column_name);
      expect(names).toEqual(expect.arrayContaining(['access_token_encrypted', 'webhook_token_encrypted', 'webhook_token_lookup']));
      const cons = await su.query("select conname from pg_constraint where conname like '%_enc_fmt' or conname like '%lookup_fmt'");
      expect(cons.rows.length).toBeGreaterThanOrEqual(5);
    } finally {
      su.release();
    }
  });

  it('anon/authenticated NÃO leem integrations nem google_tokens (nem colunas cifradas)', async () => {
    await deniedAs('anon', null, 'select access_token_encrypted from public.integrations');
    await deniedAs('authenticated', A_OWNER, 'select access_token, access_token_encrypted, webhook_token_lookup from public.integrations');
    await deniedAs('authenticated', A_OWNER, 'select refresh_token_encrypted from public.google_tokens');
    await deniedAs('anon', null, 'select refresh_token from public.google_tokens');
  });

  it('view google_connection_status: só estado, nunca token/ciphertext', async () => {
    await asUser(A_OWNER, async (c) => {
      const r = await c.query('select * from public.google_connection_status');
      if (r.rows.length) {
        const keys = Object.keys(r.rows[0]);
        expect(keys).not.toContain('refresh_token');
        expect(keys).not.toContain('refresh_token_encrypted');
        expect(keys).toEqual(expect.arrayContaining(['connected', 'expires_at']));
      }
    });
  });

  it('view integration_status: sem token/ciphertext; escopada por org/owner', async () => {
    await asUser(A_OWNER, async (c) => {
      const r = await c.query('select * from public.integration_status');
      const keys = r.rows.length ? Object.keys(r.rows[0]) : [];
      for (const k of ['access_token', 'webhook_token', 'access_token_encrypted', 'webhook_token_encrypted', 'webhook_token_lookup']) {
        expect(keys).not.toContain(k);
      }
      // A_OWNER só enxerga integrações do próprio doctor
      for (const row of r.rows) expect(row.doctor_id).toBe(DOC_A);
    });
    // B_OWNER não vê a integração da org A
    await asUser(B_OWNER, async (c) => {
      const r = await c.query('select doctor_id from public.integration_status');
      for (const row of r.rows) expect(row.doctor_id).not.toBe(DOC_A);
    });
  });

  it('NOBODY não vê nenhuma linha de integration_status', async () => {
    await asUser(NOBODY, async (c) => {
      const r = await c.query('select * from public.integration_status');
      expect(r.rows).toHaveLength(0);
    });
  });

  it('platform_admin vê integration_status de todas as orgs (regra documentada)', async () => {
    await asUser(PLAT_ADMIN, async (c) => {
      const r = await c.query('select distinct doctor_id from public.integration_status');
      expect(r.rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('índice do blind index existe e não há índice em ciphertext', async () => {
    const su = await pool.connect();
    try {
      const idx = await su.query("select indexdef from pg_indexes where tablename='integrations'");
      const defs = idx.rows.map((r) => r.indexdef).join('\n');
      expect(defs).toMatch(/webhook_token_lookup/);
      expect(defs).not.toMatch(/access_token_encrypted|webhook_token_encrypted/);
    } finally {
      su.release();
    }
  });
});
