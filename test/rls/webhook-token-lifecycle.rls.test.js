import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// FASE 2.4 — RLS real da migration 0011 (webhook_token_events + metadados).
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
const NOBODY = '00000000-0000-4000-8000-00000000dead';

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
async function deniedAs(role, sub, sql) {
  await expect(withRole(role, sub, (c) => c.query(sql))).rejects.toThrow(/permission denied|row-level security|violates/i);
}

d('RLS — webhook token lifecycle (0011) — Supabase local', () => {
  beforeAll(() => { pool = new pg.Pool({ connectionString: DB_URL, max: 3 }); });
  afterAll(async () => { if (pool) await pool.end(); });

  it('0011: colunas de rotação + tabela de auditoria existem', async () => {
    const su = await pool.connect();
    try {
      const cols = await su.query(
        "select column_name from information_schema.columns where table_name='integrations' and column_name in ('webhook_token_rotated_at','webhook_token_fingerprint')"
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual(['webhook_token_fingerprint', 'webhook_token_rotated_at']);
      const t = await su.query("select to_regclass('public.webhook_token_events') t");
      expect(t.rows[0].t).toBe('webhook_token_events');
    } finally { su.release(); }
  });

  it('webhook_token_events: deny-all para anon e authenticated', async () => {
    await deniedAs('anon', null, 'select * from public.webhook_token_events');
    await deniedAs('authenticated', A_OWNER, 'select * from public.webhook_token_events');
    await deniedAs('authenticated', A_OWNER, "insert into public.webhook_token_events (integration_id, gateway, result) values (gen_random_uuid(),'pagarme','success')");
    await deniedAs('authenticated', NOBODY, 'select id from public.webhook_token_events');
  });

  it('integration_status: expõe fingerprint/rotated_at mas NUNCA o token', async () => {
    await withRole('authenticated', A_OWNER, async (c) => {
      const r = await c.query('select * from public.integration_status limit 1');
      const keys = r.rows.length ? Object.keys(r.rows[0]) : [];
      if (keys.length) {
        expect(keys).toEqual(expect.arrayContaining(['has_webhook_token', 'webhook_token_fingerprint', 'webhook_token_rotated_at']));
        for (const bad of ['webhook_token', 'webhook_token_encrypted', 'webhook_token_lookup']) {
          expect(keys).not.toContain(bad);
        }
      }
    });
  });

  it('authenticated continua sem SELECT direto em integrations (fingerprint só via view)', async () => {
    await deniedAs('authenticated', A_OWNER, 'select webhook_token_fingerprint from public.integrations');
  });

  it('CAS atômico: dois UPDATE condicionais concorrentes -> exatamente um afeta 1 linha', async () => {
    const su = await pool.connect();
    let integId;
    try {
      const r = await su.query("select id from public.integrations where gateway='pagarme' limit 1");
      integId = r.rows[0]?.id;
      if (!integId) return; // seed sem pagarme -> pula
      // estado inicial conhecido (nunca rotacionado)
      await su.query('update public.integrations set webhook_token_rotated_at=null, webhook_token_fingerprint=null where id=$1', [integId]);
    } finally {
      su.release();
    }

    // dois clientes independentes, transações abertas, mesmo WHERE de CAS
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query('begin');
      await c2.query('begin');
      const cas = (fp) =>
        `update public.integrations
           set webhook_token='tok-${fp}', webhook_token_fingerprint='${fp}', webhook_token_rotated_at=now()
         where id='${integId}'
           and webhook_token_rotated_at is not distinct from null
           and webhook_token_fingerprint is not distinct from null
         returning id`;
      // c1 aplica e mantém a transação aberta (segura o lock da linha)
      const r1 = await c1.query(cas('aaaaaaaaaaaa'));
      // c2 dispara o mesmo CAS -> bloqueia no lock de c1
      const p2 = c2.query(cas('bbbbbbbbbbbb'));
      await c1.query('commit'); // libera o lock; c2 re-avalia o WHERE
      const r2 = await p2;
      await c2.query('commit');

      const affected = [r1.rowCount, r2.rowCount].sort();
      expect(affected).toEqual([0, 1]); // exatamente um venceu

      // estado final único e consistente
      const fin = await pool.query('select webhook_token, webhook_token_fingerprint from public.integrations where id=$1', [integId]);
      expect(fin.rows[0].webhook_token_fingerprint).toBe('aaaaaaaaaaaa');
      expect(fin.rows[0].webhook_token).toBe('tok-aaaaaaaaaaaa');
    } finally {
      await c1.query('rollback').catch(() => {});
      await c2.query('rollback').catch(() => {});
      c1.release();
      c2.release();
      // restaura o seed
      const c = await pool.connect();
      await c.query('update public.integrations set webhook_token_rotated_at=null, webhook_token_fingerprint=null where id=$1', [integId]).catch(() => {});
      c.release();
    }
  });

  it('webhook_token_events.result aceita success e conflict (auditoria CAS)', async () => {
    const su = await pool.connect();
    try {
      await su.query('begin');
      const int = await su.query("select id, organization_id, gateway from public.integrations where gateway='pagarme' limit 1");
      if (int.rows.length) {
        const { id, organization_id, gateway } = int.rows[0];
        for (const result of ['success', 'conflict', 'error']) {
          await su.query(
            "insert into public.webhook_token_events (integration_id, organization_id, gateway, action, result) values ($1,$2,$3,'rotate',$4)",
            [id, organization_id, gateway, result]
          );
        }
        await expect(
          su.query("insert into public.webhook_token_events (integration_id, gateway, action, result) values ($1,'pagarme','rotate','bogus')", [id])
        ).rejects.toThrow(/violates check constraint/i);
      }
      await su.query('rollback');
    } finally { su.release(); }
  });

  it('constraint de fingerprint: rejeita valor fora de ^[a-f0-9]{6,32}$', async () => {
    const su = await pool.connect();
    try {
      await su.query('begin');
      const int = await su.query("select id from public.integrations where gateway='pagarme' limit 1");
      if (int.rows.length) {
        await expect(
          su.query('update public.integrations set webhook_token_fingerprint=$1 where id=$2', ['NOT-HEX!!', int.rows[0].id])
        ).rejects.toThrow(/violates check constraint/i);
      }
      await su.query('rollback');
    } finally { su.release(); }
  });
});
