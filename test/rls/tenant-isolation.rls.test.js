import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// -----------------------------------------------------------------------------
// Testes de INTEGRAÇÃO de RLS contra um Postgres do Supabase LOCAL.
//
//   1. `npx supabase start`  (Docker)
//   2. `npx supabase db reset`  (baseline + migrations 0003-0006 + seed.sql)
//   3. rodar com:
//      SUPABASE_TEST_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
//        npx vitest run test/rls
//
// Sem SUPABASE_TEST_DB_URL (ou sem `pg`), a suíte é PULADA — `npm test` não
// depende de Docker.
//
// NENHUMA query usa `service_role`. Todo acesso é como `anon` ou `authenticated`
// com `request.jwt.claims` setado (simula o PostgREST). Zero chamada externa.
// -----------------------------------------------------------------------------

const DB_URL = process.env.SUPABASE_TEST_DB_URL;
let pg;
try {
  pg = (await import('pg')).default;
} catch {
  pg = null;
}
const RUN = Boolean(DB_URL && pg);
const d = RUN ? describe : describe.skip;

// IDs do seed.sql (todos hex-válidos)
const A_OWNER = '00000000-0000-4000-8000-00000000a001';
const B_OWNER = '00000000-0000-4000-8000-00000000b001';
const A_CLOSER = '00000000-0000-4000-8000-00000000ac01';
const PLAT_ADMIN = '00000000-0000-4000-8000-00000000ad01';
const NOBODY = '00000000-0000-4000-8000-00000000dead';
const DA = '00000000-0000-4000-8000-0000000000da';
const DB = '00000000-0000-4000-8000-0000000000db';
const LEAD_A1 = '00000000-0000-4000-8000-0000000001a1';
const LEAD_B1 = '00000000-0000-4000-8000-0000000001b1';
const DEAL_B = '00000000-0000-4000-8000-00000000031b';
const EVENT_B = '00000000-0000-4000-8000-00000000041b';

let pool;

// Executa uma unidade de trabalho num papel + claims, sempre com ROLLBACK
// (limpeza entre casos — nada persiste).
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
const asAnon = (fn) => withRole('anon', null, fn);
const asUser = (sub, fn) => withRole('authenticated', sub, fn);
const count = async (client, sql, params) => Number((await client.query(sql, params)).rows[0].n);

// Cada query em sua PRÓPRIA transação (um erro aborta a transação inteira).
async function expectDenied(role, sub, sql, params) {
  await expect(
    withRole(role, sub, (c) => c.query(sql, params))
  ).rejects.toThrow(/permission denied|row-level security|violates/i);
}
async function rowCountAs(role, sub, sql, params) {
  return withRole(role, sub, async (c) => (await c.query(sql, params)).rowCount);
}

d('RLS — isolamento entre organizações (Supabase local)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  // ---- 1. anon não acessa campanhas / knowledge_base / knowledge_chunks ----
  // (migration 0003 revogou os grants -> `permission denied`, não apenas 0 linhas)
  it('1. anon: SELECT em campanhas é negado (permission denied)', () =>
    expectDenied('anon', null, 'select * from public.campanhas'));
  it('1b. anon: SELECT em knowledge_base é negado', () =>
    expectDenied('anon', null, 'select * from public.knowledge_base'));
  it('1c. anon: SELECT em knowledge_chunks é negado', () =>
    expectDenied('anon', null, 'select * from public.knowledge_chunks'));
  it('1d. anon: INSERT em campanhas é negado', () =>
    expectDenied('anon', null, "insert into public.campanhas(doctor_id,nome,mensagem) values ($1,'x','y')", [DA]));
  it('1e. anon: UPDATE em knowledge_base é negado', () =>
    expectDenied('anon', null, 'update public.knowledge_base set titulo=$1', ['h']));
  it('1f. anon: DELETE em campanhas é negado', () =>
    expectDenied('anon', null, 'delete from public.campanhas'));

  // ---- 2. authenticated sem membership não acessa dados de organização ----
  it('2. authenticated sem membership: 0 linhas em leads/doctors/events', async () => {
    await asUser(NOBODY, async (c) => {
      expect(await count(c, 'select count(*)::int n from public.leads')).toBe(0);
      expect(await count(c, 'select count(*)::int n from public.doctors')).toBe(0);
      expect(await count(c, 'select count(*)::int n from public.events')).toBe(0);
    });
  });
  it('2b. authenticated sem membership: deals (RLS on, sem policy) retorna 0 linhas', async () => {
    await asUser(NOBODY, async (c) => {
      expect(await count(c, 'select count(*)::int n from public.deals')).toBe(0);
    });
  });

  // ---- 3. closer da Org A não LÊ dados da Org B ----
  it('3. closer A: SELECT em leads não retorna nada da Org B', async () => {
    await asUser(A_CLOSER, async (c) => {
      expect(await count(c, 'select count(*)::int n from public.leads where doctor_id=$1', [DB])).toBe(0);
      // vê os próprios (carteira) da Org A
      expect(await count(c, 'select count(*)::int n from public.leads where doctor_id=$1', [DA])).toBeGreaterThan(0);
    });
  });

  // ---- 4. closer A não ALTERA lead / deal / evento da Org B ----
  // Pós-0008 (AR-2): grants de INSERT/DELETE em leads foram revogados do browser;
  // UPDATE só nas colunas status_atual/dados_extraidos. Escrita "real" via API.
  it('4. closer A: UPDATE em lead da Org B não afeta nenhuma linha (coluna permitida)', async () => {
    await asUser(A_CLOSER, async (c) => {
      const r = await c.query('update public.leads set status_atual=$1 where id=$2', ['hacked', LEAD_B1]);
      expect(r.rowCount).toBe(0);
    });
  });
  it('4b. closer A: DELETE direto em leads é negado (grant revogado pela 0008)', () =>
    expectDenied('authenticated', A_CLOSER, 'delete from public.leads where id=$1', [LEAD_B1]));
  it('4c. closer A: INSERT direto em leads é negado (grant revogado pela 0008)', () =>
    expectDenied('authenticated', A_CLOSER, "insert into public.leads(doctor_id,nome) values ($1,'x')", [DB]));
  it('4d. closer A: UPDATE em deal da Org B afeta 0 linhas (deals: RLS deny-all)', async () => {
    expect(await rowCountAs('authenticated', A_CLOSER, 'update public.deals set etapa=$1 where id=$2', ['x', DEAL_B])).toBe(0);
  });
  it('4e. closer A: UPDATE em evento da Org B afeta 0 linhas', async () => {
    expect(await rowCountAs('authenticated', A_CLOSER, 'update public.events set status=$1 where id=$2', ['cancelado', EVENT_B])).toBe(0);
  });

  // ---- 5 / 6. doctor A e doctor B só a própria organização ----
  it('5. doctor A: SELECT leads/doctors só mostra a Org A', async () => {
    await asUser(A_OWNER, async (c) => {
      const leads = await c.query('select distinct doctor_id from public.leads');
      expect(leads.rows.map((x) => x.doctor_id)).toEqual([DA]);
      const docs = await c.query('select id from public.doctors');
      expect(docs.rows.map((x) => x.id)).toEqual([DA]);
    });
  });
  it('6. doctor B: SELECT leads/doctors só mostra a Org B', async () => {
    await asUser(B_OWNER, async (c) => {
      const leads = await c.query('select distinct doctor_id from public.leads');
      expect(leads.rows.map((x) => x.doctor_id)).toEqual([DB]);
      const docs = await c.query('select id from public.doctors');
      expect(docs.rows.map((x) => x.id)).toEqual([DB]);
    });
  });
  it('5b. doctor A: caminho feliz — UPDATE do próprio lead funciona', async () => {
    await asUser(A_OWNER, async (c) => {
      const r = await c.query('update public.leads set status_atual=$1 where id=$2', ['conversa_iniciada', LEAD_A1]);
      expect(r.rowCount).toBe(1);
    });
  });

  // ---- 7. admin de plataforma segue a regra documentada (is_admin -> tudo) ----
  it('7. admin de plataforma: is_admin() true e vê leads das duas orgs', async () => {
    await asUser(PLAT_ADMIN, async (c) => {
      expect((await c.query('select public.is_admin() as a')).rows[0].a).toBe(true);
      const ids = (await c.query('select distinct doctor_id from public.leads')).rows.map((x) => x.doctor_id).sort();
      expect(ids).toEqual([DA, DB].sort());
    });
  });
  it('7b. usuário comum: is_admin() false', async () => {
    await asUser(A_OWNER, async (c) => {
      expect((await c.query('select public.is_admin() as a')).rows[0].a).toBe(false);
    });
  });

  // ---- 8. trocar doctor_id no payload: bloqueado (grant de UPDATE dessa coluna revogado pela 0008) ----
  it('8. doctor A: UPDATE de doctor_id direto em leads é negado', () =>
    expectDenied('authenticated', A_OWNER, 'update public.leads set doctor_id=$1 where id=$2', [DB, LEAD_A1]));
  it('8b. doctor A: INSERT direto em leads é negado (grant revogado)', () =>
    expectDenied('authenticated', A_OWNER, "insert into public.leads(doctor_id,nome) values ($1,'x')", [DB]));

  // ---- 9. consultar por ID conhecido de outra org falha ----
  it('9. doctor A: SELECT por id de lead da Org B retorna 0 linhas', async () => {
    await asUser(A_OWNER, async (c) => {
      expect(await count(c, 'select count(*)::int n from public.leads where id=$1', [LEAD_B1])).toBe(0);
    });
    await asUser(A_CLOSER, async (c) => {
      expect(await count(c, 'select count(*)::int n from public.leads where id=$1', [LEAD_B1])).toBe(0);
    });
  });

  // ---- 11. integrations/google_tokens: pós-0008 (AR-3) o browser NÃO lê essas
  //      tabelas de jeito nenhum (grant de SELECT revogado). Estado seguro via view.
  it('11. doctor A: SELECT direto em integrations é negado (AR-3)', () =>
    expectDenied('authenticated', A_OWNER, 'select access_token, webhook_token from public.integrations'));
  it('11b. usuário: SELECT direto em google_tokens é negado (AR-3)', () =>
    expectDenied('authenticated', A_OWNER, 'select refresh_token from public.google_tokens'));

  // ---- 12. migrations 0003-0006 deixaram grants/policies no estado esperado ----
  it('12. pós-migrations: anon/authenticated SEM grant em campanhas/knowledge_base/knowledge_chunks/webhook_events/campanha_envios', async () => {
    // consultado como superuser (postgres) — só leitura de catálogo, não de dados
    const su = await pool.connect();
    try {
      const q = `select grantee, table_name, privilege_type
                 from information_schema.role_table_grants
                 where table_schema='public'
                   and grantee in ('anon','authenticated')
                   and table_name in ('campanhas','knowledge_base','knowledge_chunks','webhook_events','campanha_envios')`;
      const r = await su.query(q);
      expect(r.rows).toHaveLength(0); // 0003/0005/0006 revogaram tudo
      // policies inseguras removidas
      const pol = await su.query(
        "select policyname from pg_policies where schemaname='public' and policyname in ('service_role_all_campanhas','service_role_all_knowledge_base')"
      );
      expect(pol.rows).toHaveLength(0);
      // 0004: coluna status + constraint
      const col = await su.query(
        "select column_name from information_schema.columns where table_schema='public' and table_name='users' and column_name='status'"
      );
      expect(col.rows).toHaveLength(1);
      const chk = await su.query("select conname from pg_constraint where conname='users_status_check'");
      expect(chk.rows).toHaveLength(1);
      // 0005 / 0006: tabelas existem
      for (const t of ['webhook_events', 'campanha_envios']) {
        const e = await su.query('select 1 from information_schema.tables where table_schema=$1 and table_name=$2', ['public', t]);
        expect(e.rows).toHaveLength(1);
      }
      // 0006: coluna campanhas.processando_desde
      const pd = await su.query(
        "select 1 from information_schema.columns where table_schema='public' and table_name='campanhas' and column_name='processando_desde'"
      );
      expect(pd.rows).toHaveLength(1);
    } finally {
      su.release();
    }
  });

  // ---- 13. hardening 0007: helpers SECURITY DEFINER com search_path fixo e sem EXECUTE p/ anon ----
  it('13. is_admin/is_doctor_owner/user_has_doctor_access: search_path fixo e EXECUTE só authenticated', async () => {
    const su = await pool.connect();
    try {
      const cfg = await su.query(
        "select proname, proconfig, prosecdef from pg_proc where pronamespace='public'::regnamespace and proname in ('is_admin','is_doctor_owner','user_has_doctor_access')"
      );
      expect(cfg.rows).toHaveLength(3);
      for (const r of cfg.rows) {
        expect(r.prosecdef).toBe(true);
        expect((r.proconfig || []).some((s) => s.startsWith('search_path='))).toBe(true);
      }
      // anon perdeu o EXECUTE
      const g = await su.query(
        "select routine_name from information_schema.role_routine_grants where routine_schema='public' and grantee='anon' and routine_name in ('is_admin','is_doctor_owner','user_has_doctor_access')"
      );
      expect(g.rows).toHaveLength(0);
    } finally {
      su.release();
    }
  });

  // ---- 10. SELECT/INSERT/UPDATE/DELETE testados separadamente ----
  // SELECT do próprio: ok. INSERT/DELETE direto: negado pós-0008 (só a API/service-role escreve).
  it('10. doctor A: SELECT do próprio lead funciona (happy path de SELECT)', async () => {
    await asUser(A_OWNER, async (c) => {
      const r = await c.query('select id from public.leads where id=$1', [LEAD_A1]);
      expect(r.rows).toHaveLength(1);
    });
  });
  it('10b. doctor A: UPDATE de coluna permitida do próprio lead funciona', async () => {
    await asUser(A_OWNER, async (c) => {
      const r = await c.query("update public.leads set status_atual='proposta' where id=$1", [LEAD_A1]);
      expect(r.rowCount).toBe(1);
    });
  });
  it('10c. doctor A: INSERT/DELETE direto em leads é negado (grant revogado — escrita via API)', async () => {
    await expectDenied('authenticated', A_OWNER, "insert into public.leads(doctor_id,nome) values ($1,'novo')", [DA]);
    await expectDenied('authenticated', A_OWNER, 'delete from public.leads where id=$1', [LEAD_A1]);
  });
});
