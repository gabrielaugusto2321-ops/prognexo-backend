import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// -----------------------------------------------------------------------------
// Testes de INTEGRAÇÃO de RLS — rodam contra um Postgres do Supabase LOCAL.
//
// Pré-requisitos (ver supabase/README.md):
//   1. `npx supabase start` (Docker)
//   2. baseline + migrations 0003-0006 + seed.sql aplicados (`npx supabase db reset`)
//   3. `npm i -D pg`
//   4. rodar com:
//      SUPABASE_TEST_DB_URL="postgresql://postgres:postgres@localhost:54322/postgres" npx vitest run test/rls
//
// Sem SUPABASE_TEST_DB_URL (ou sem `pg` instalado), a suíte é PULADA — o
// `npm test` normal não depende de Docker.
// -----------------------------------------------------------------------------

const DB_URL = process.env.SUPABASE_TEST_DB_URL;

let Client;
try {
  ({ Client } = await import('pg'));
} catch {
  Client = null;
}

const RUN = Boolean(DB_URL && Client);
const d = RUN ? describe : describe.skip;

// IDs do seed.sql
const ORG_A = '00000000-0000-4000-8000-0000000da001';
const ORG_B = '00000000-0000-4000-8000-0000000db001';
const A_OWNER = '00000000-0000-4000-8000-00000000a001';
const B_OWNER = '00000000-0000-4000-8000-00000000b001';
const A_CLOSER = '00000000-0000-4000-8000-0000000ac001';
const PLAT_ADMIN = '00000000-0000-4000-8000-00000plat001';

let client;

// Executa uma query assumindo um papel + claims (simula PostgREST).
async function asRole(role, sub, sql) {
  await client.query('begin');
  try {
    await client.query(`set local role ${role}`);
    if (sub) {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub, role: 'authenticated' }),
      ]);
    }
    const res = await client.query(sql);
    return res;
  } finally {
    await client.query('rollback');
  }
}

d('RLS — isolamento entre organizações (Supabase local)', () => {
  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    if (client) await client.end();
  });

  it('anon NÃO lê leads', async () => {
    const r = await asRole('anon', null, 'select count(*)::int as n from public.leads');
    expect(r.rows[0].n).toBe(0);
  });

  it('authenticated sem membership NÃO lê leads', async () => {
    // sub aleatório que não é dono nem closer de nada
    const r = await asRole('authenticated', '00000000-0000-4000-8000-00000000dead', 'select count(*)::int as n from public.leads');
    expect(r.rows[0].n).toBe(0);
  });

  it('doctor da Org A vê só os próprios leads', async () => {
    const r = await asRole('authenticated', A_OWNER, 'select doctor_id from public.leads');
    expect(r.rows.every((x) => x.doctor_id === ORG_A)).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it('closer da Org A NÃO vê leads da Org B', async () => {
    const r = await asRole('authenticated', A_CLOSER, `select count(*)::int as n from public.leads where doctor_id = '${ORG_B}'`);
    expect(r.rows[0].n).toBe(0);
  });

  it('doctor da Org B NÃO vê a Org A em doctors', async () => {
    const r = await asRole('authenticated', B_OWNER, 'select id from public.doctors');
    expect(r.rows.every((x) => x.id === ORG_B)).toBe(true);
  });

  it('admin de plataforma vê leads das duas orgs (is_admin())', async () => {
    const r = await asRole('authenticated', PLAT_ADMIN, 'select distinct doctor_id from public.leads');
    const ids = r.rows.map((x) => x.doctor_id).sort();
    expect(ids).toEqual([ORG_A, ORG_B].sort());
  });

  it('LOCKDOWN R01 (após migration 0003): anon NÃO lê campanhas nem knowledge_base', async () => {
    await expect(asRole('anon', null, 'select * from public.campanhas')).rejects.toThrow(/permission denied|not exist/i);
    await expect(asRole('anon', null, 'select * from public.knowledge_base')).rejects.toThrow(/permission denied|not exist/i);
  });

  it('LOCKDOWN R01: authenticated de outra org NÃO lê campanhas', async () => {
    await expect(
      asRole('authenticated', B_OWNER, 'select * from public.campanhas')
    ).rejects.toThrow(/permission denied/i);
  });
});
