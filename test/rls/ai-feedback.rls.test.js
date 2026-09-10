import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// -----------------------------------------------------------------------------
// FASE 3.3A — RLS / grants do feedback humano da Auditoria de IA.
// Integração contra o Postgres do Supabase LOCAL (migration 0015 aplicada).
//
//   1. npx supabase start
//   2. npx supabase db reset      (baseline -> ... -> 0015 -> seed)
//   3. SUPABASE_TEST_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
//        npx vitest run test/rls/ai-feedback.rls.test.js
//
// Sem SUPABASE_TEST_DB_URL (ou sem `pg`) a suíte é PULADA.
// NENHUMA query usa service_role. Só `anon` / `authenticated` com claims.
// -----------------------------------------------------------------------------

const DB_URL = process.env.SUPABASE_TEST_DB_URL;
let pg;
try { pg = (await import('pg')).default; } catch { pg = null; }
const RUN = Boolean(DB_URL && pg);
const d = RUN ? describe : describe.skip;

const A_OWNER = '00000000-0000-4000-8000-00000000a001';
const B_OWNER = '00000000-0000-4000-8000-00000000b001';
const A_CLOSER = '00000000-0000-4000-8000-00000000ac01';
const LEAD_A1 = '00000000-0000-4000-8000-0000000001a1';
const LEAD_B1 = '00000000-0000-4000-8000-0000000001b1';

let pool;

async function withRole(role, sub, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    if (sub) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub, role: 'authenticated' }),
      ]);
    } else {
      await client.query("select set_config('request.jwt.claims', '', true)");
    }
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}
async function expectDenied(role, sub, sql, params) {
  await expect(withRole(role, sub, (c) => c.query(sql, params)))
    .rejects.toThrow(/permission denied|row-level security|violates/i);
}

d('RLS — feedback da Auditoria de IA (Supabase local)', () => {
  beforeAll(() => { pool = new pg.Pool({ connectionString: DB_URL, max: 4 }); });
  afterAll(async () => { if (pool) await pool.end(); });

  it('migration 0015 aplicada: colunas existem e vêm depois da 0014', async () => {
    await withRole('authenticated', A_OWNER, async (c) => {
      const cols = await c.query(
        `select column_name, is_nullable, data_type from information_schema.columns
         where table_schema='public' and table_name='leads'
           and column_name in ('feedback_ia','feedback_ia_at','feedback_ia_by')
         order by column_name`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(['feedback_ia', 'feedback_ia_at', 'feedback_ia_by']);
      expect(cols.rows.every((r) => r.is_nullable === 'YES')).toBe(true);
    });
    // 0015 registrada depois de 0014 no histórico de migrations do supabase
    const hist = await withRole('authenticated', A_OWNER, (c) =>
      c.query(`select version from supabase_migrations.schema_migrations
               where version in ('00000000000014','00000000000015') order by version`).catch(() => ({ rows: [] })));
    if (hist.rows.length === 2) {
      expect(hist.rows.map((r) => r.version)).toEqual(['00000000000014', '00000000000015']);
    }
  });

  it('CHECK estrito leads_feedback_ia_check existe e cobre só bom/ruim/null', async () => {
    const r = await withRole('authenticated', A_OWNER, (c) =>
      c.query(`select pg_get_constraintdef(oid) def from pg_constraint
               where conname = 'leads_feedback_ia_check'`));
    expect(r.rows).toHaveLength(1);
    const def = r.rows[0].def.toLowerCase();
    expect(def).toContain("'bom'");
    expect(def).toContain("'ruim'");
    expect(def).not.toContain("'reuniao'");
  });

  it('feedback_ia_by referencia public.users (on delete set null)', async () => {
    const r = await withRole('authenticated', A_OWNER, (c) =>
      c.query(`select confdeltype, pg_get_constraintdef(oid) def from pg_constraint
               where conrelid = 'public.leads'::regclass and contype = 'f'
                 and pg_get_constraintdef(oid) ilike '%feedback_ia_by%'`));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].def.toLowerCase()).toMatch(/references (public\.)?users\(id\)/);
    expect(r.rows[0].confdeltype).toBe('n'); // SET NULL
  });

  it('grants mínimos: authenticated NÃO tem UPDATE em feedback_ia (só a API escreve)', async () => {
    await withRole('authenticated', A_OWNER, async (c) => {
      const canFeedback = await c.query(
        "select has_column_privilege('authenticated','public.leads','feedback_ia','UPDATE') as ok");
      expect(canFeedback.rows[0].ok).toBe(false);
      // o grant legado permanece intacto e mínimo
      const canStatus = await c.query(
        "select has_column_privilege('authenticated','public.leads','status_atual','UPDATE') as ok");
      expect(canStatus.rows[0].ok).toBe(true);
      const canBy = await c.query(
        "select has_column_privilege('authenticated','public.leads','feedback_ia_by','UPDATE') as ok");
      expect(canBy.rows[0].ok).toBe(false);
    });
  });

  it('dono da clínica NÃO consegue setar feedback_ia direto pelo PostgREST', () =>
    expectDenied('authenticated', A_OWNER,
      "update public.leads set feedback_ia = 'bom' where id = $1", [LEAD_A1]));

  it('nem bundlando com uma coluna permitida', () =>
    expectDenied('authenticated', A_OWNER,
      "update public.leads set status_atual = 'lead', feedback_ia = 'ruim' where id = $1", [LEAD_A1]));

  it('closer também não consegue setar feedback_ia direto', () =>
    expectDenied('authenticated', A_CLOSER,
      "update public.leads set feedback_ia = 'bom' where id = $1", [LEAD_A1]));

  it('anon não consegue nada', () =>
    expectDenied('anon', null, "update public.leads set feedback_ia = 'bom'"));

  it('isolamento entre organizações: B_OWNER não enxerga o lead A (nem o feedback)', async () => {
    await withRole('authenticated', B_OWNER, async (c) => {
      const r = await c.query('select count(*)::int n from public.leads where id = $1', [LEAD_A1]);
      expect(r.rows[0].n).toBe(0);
    });
    await withRole('authenticated', A_OWNER, async (c) => {
      const r = await c.query('select count(*)::int n from public.leads where id = $1', [LEAD_B1]);
      expect(r.rows[0].n).toBe(0);
    });
  });
});
