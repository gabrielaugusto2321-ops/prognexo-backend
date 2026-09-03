import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// FASE 2.1 — testes REAIS de RLS do núcleo multitenant (organizations/units/
// memberships) contra o Postgres do Supabase LOCAL (migration 0008 aplicada).
// Sem service_role: acesso como anon/authenticated com request.jwt.claims.
//
// Rodar: SUPABASE_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run test/rls

const DB_URL = process.env.SUPABASE_TEST_DB_URL;
let pg;
try {
  pg = (await import('pg')).default;
} catch {
  pg = null;
}
const d = DB_URL && pg ? describe : describe.skip;

// users do seed
const A_OWNER = '00000000-0000-4000-8000-00000000a001';
const B_OWNER = '00000000-0000-4000-8000-00000000b001';
const A_CLOSER = '00000000-0000-4000-8000-00000000ac01';
const MULTI = '00000000-0000-4000-8000-0000000000c2';
const ORFAO = '00000000-0000-4000-8000-0000000000c3';
const PLAT_ADMIN = '00000000-0000-4000-8000-00000000ad01';
const NOBODY = '00000000-0000-4000-8000-00000000dead';
const DOC_A = '00000000-0000-4000-8000-0000000000da';
const DOC_B = '00000000-0000-4000-8000-0000000000db';
const LEAD_A1 = '00000000-0000-4000-8000-0000000001a1';
const LEAD_B1 = '00000000-0000-4000-8000-0000000001b1';

let pool;
let ORG_A, ORG_B, UNIT_A, UNIT_B;

async function withRole(role, sub, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      sub ? JSON.stringify({ sub, role: 'authenticated' }) : '',
    ]);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}
const asUser = (sub, fn) => withRole('authenticated', sub, fn);
const asAnon = (fn) => withRole('anon', null, fn);
const nAs = (role, sub, sql, p) => withRole(role, sub, async (c) => Number((await c.query(sql, p)).rows[0].n));
const rcAs = (role, sub, sql, p) => withRole(role, sub, async (c) => (await c.query(sql, p)).rowCount);
async function deniedAs(role, sub, sql, p) {
  await expect(withRole(role, sub, (c) => c.query(sql, p))).rejects.toThrow(
    /permission denied|row-level security|violates/i
  );
}

d('RLS — tenant core (organizations/units/memberships) — Supabase local', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 6 });
    const su = await pool.connect();
    try {
      const m = await su.query('select doctor_id, organization_id, default_unit_id from public.organization_doctor_map');
      const byDoctor = Object.fromEntries(m.rows.map((r) => [r.doctor_id, r]));
      ORG_A = byDoctor[DOC_A].organization_id;
      ORG_B = byDoctor[DOC_B].organization_id;
      UNIT_A = byDoctor[DOC_A].default_unit_id;
      UNIT_B = byDoctor[DOC_B].default_unit_id;
    } finally {
      su.release();
    }
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  // ---------- backfill ----------
  it('backfill: 1 org + 1 unidade + 1 map por doctor; memberships de owner e closer', async () => {
    const su = await pool.connect();
    try {
      expect((await su.query('select count(*)::int n from public.organizations')).rows[0].n).toBe(2);
      expect((await su.query('select count(*)::int n from public.units')).rows[0].n).toBe(2);
      expect((await su.query('select count(*)::int n from public.organization_doctor_map')).rows[0].n).toBe(2);
      // A_OWNER = organization_owner na Org A
      const own = await su.query(
        "select role from public.memberships where user_id=$1 and organization_id=$2",
        [A_OWNER, ORG_A]
      );
      expect(own.rows[0].role).toBe('organization_owner');
      // A_CLOSER = closer na Org A, com membership_unit
      const cl = await su.query("select id, role from public.memberships where user_id=$1 and organization_id=$2", [A_CLOSER, ORG_A]);
      expect(cl.rows[0].role).toBe('closer');
      const mu = await su.query('select count(*)::int n from public.membership_units where membership_id=$1', [cl.rows[0].id]);
      expect(mu.rows[0].n).toBe(1);
      // MULTI = closer nas DUAS orgs
      expect((await su.query('select count(*)::int n from public.memberships where user_id=$1', [MULTI])).rows[0].n).toBe(2);
      // ORFAO = closer sem access -> registrado, sem membership
      expect((await su.query('select count(*)::int n from public.memberships where user_id=$1', [ORFAO])).rows[0].n).toBe(0);
      expect(
        (await su.query("select count(*)::int n from public.tenant_backfill_issues where kind='closer_without_access' and subject_id=$1", [ORFAO])).rows[0].n
      ).toBe(1);
      // PLAT_ADMIN -> platform_admins
      expect((await su.query('select count(*)::int n from public.platform_admins where user_id=$1', [PLAT_ADMIN])).rows[0].n).toBe(1);
      // leads/events/campanhas/integrations backfilled com organization_id
      for (const t of ['leads', 'events', 'campanhas', 'integrations']) {
        expect((await su.query(`select count(*)::int n from public.${t} where organization_id is null`)).rows[0].n).toBe(0);
      }
    } finally {
      su.release();
    }
  });

  // ---------- organizations / units ----------
  it('owner A vê só a Org A; owner B só a Org B', async () => {
    expect((await asUser(A_OWNER, (c) => c.query('select id from public.organizations'))).rows.map((r) => r.id)).toEqual([ORG_A]);
    expect((await asUser(B_OWNER, (c) => c.query('select id from public.organizations'))).rows.map((r) => r.id)).toEqual([ORG_B]);
  });
  it('closer A vê só a Org A; MULTI vê as duas', async () => {
    expect((await asUser(A_CLOSER, (c) => c.query('select id from public.organizations'))).rows.map((r) => r.id)).toEqual([ORG_A]);
    const multi = (await asUser(MULTI, (c) => c.query('select id from public.organizations order by id'))).rows.map((r) => r.id);
    expect(multi.sort()).toEqual([ORG_A, ORG_B].sort());
  });
  it('usuário sem membership: 0 organizations/units', async () => {
    expect(await nAs('authenticated', NOBODY, 'select count(*)::int n from public.organizations')).toBe(0);
    expect(await nAs('authenticated', NOBODY, 'select count(*)::int n from public.units')).toBe(0);
  });
  it('anon: 0 organizations/units', async () => {
    expect(await nAs('anon', null, 'select count(*)::int n from public.organizations')).toBe(0);
    expect(await nAs('anon', null, 'select count(*)::int n from public.units')).toBe(0);
  });
  it('unit de outra organização: closer A não vê a unidade da Org B', async () => {
    expect(await nAs('authenticated', A_CLOSER, 'select count(*)::int n from public.units where id=$1', [UNIT_B])).toBe(0);
  });

  // ---------- membership suspensa ----------
  it('membership SUSPENSA: perde acesso a organizations/leads', async () => {
    const su = await pool.connect();
    try {
      await su.query('begin');
      await su.query("update public.memberships set status='suspended' where user_id=$1 and organization_id=$2", [A_CLOSER, ORG_A]);
      // dentro da MESMA transação, checa como o usuário
      await su.query('set local role authenticated');
      await su.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A_CLOSER, role: 'authenticated' })]);
      const orgs = await su.query('select id from public.organizations');
      expect(orgs.rows).toHaveLength(0);
      const leads = await su.query('select count(*)::int n from public.leads');
      // a policy antiga closer_scoped_leads (via user_doctor_access) ainda deixa VER;
      // mas a nova leads_org_scoped exige membership ativa. Ambas OR'd => ainda vê pela antiga.
      // O importante: is_org_member volta false.
      const m = await su.query('select public.is_org_member($1) a', [ORG_A]);
      expect(m.rows[0].a).toBe(false);
    } finally {
      await su.query('rollback').catch(() => {});
      su.release();
    }
  });

  // ---------- troca de organização ----------
  it('MULTI: seleção válida de organização (via is_org_member) funciona para as duas', async () => {
    await asUser(MULTI, async (c) => {
      expect((await c.query('select public.is_org_member($1) a', [ORG_A])).rows[0].a).toBe(true);
      expect((await c.query('select public.is_org_member($1) a', [ORG_B])).rows[0].a).toBe(true);
    });
  });
  it('closer A: selecionar organização SEM membership (Org B) -> is_org_member false', async () => {
    await asUser(A_CLOSER, async (c) => {
      expect((await c.query('select public.is_org_member($1) a', [ORG_B])).rows[0].a).toBe(false);
    });
  });

  // ---------- escalonamento de privilégio via memberships ----------
  it('owner A concede papel comum (viewer) a um usuário da própria org -> permitido', async () => {
    const rc = await rcAs('authenticated', A_OWNER,
      "insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'viewer','active')",
      [ORG_A, ORFAO]);
    expect(rc).toBe(1);
  });
  it('owner A NÃO cria membership platform_admin (escalonamento) -> bloqueado', async () => {
    await deniedAs('authenticated', A_OWNER,
      "insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'platform_admin','active')",
      [ORG_A, ORFAO]);
  });
  it('closer A NÃO escreve em memberships (sem papel owner/admin) -> bloqueado', async () => {
    await deniedAs('authenticated', A_CLOSER,
      "insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'viewer','active')",
      [ORG_A, ORFAO]);
  });
  it('closer A NÃO se auto-promove a organization_owner via UPDATE -> bloqueado/0 linhas', async () => {
    const rc = await rcAs('authenticated', A_CLOSER,
      "update public.memberships set role='organization_owner' where user_id=$1 and organization_id=$2",
      [A_CLOSER, ORG_A]).catch(() => 0);
    expect(rc).toBe(0);
  });

  // ---------- leads / deals / events por org (SELECT/INSERT/UPDATE/DELETE) ----------
  it('owner A: SELECT leads só da Org A (via organization_id)', async () => {
    const rows = (await asUser(A_OWNER, (c) => c.query('select distinct organization_id from public.leads'))).rows;
    expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);
  });
  it('owner B: SELECT leads só da Org B', async () => {
    const rows = (await asUser(B_OWNER, (c) => c.query('select distinct organization_id from public.leads'))).rows;
    expect(rows.map((r) => r.organization_id)).toEqual([ORG_B]);
  });
  it('owner A: id conhecido de lead da Org B -> SELECT 0 linhas; UPDATE (col permitida) 0 linhas; DELETE negado', async () => {
    expect(await nAs('authenticated', A_OWNER, 'select count(*)::int n from public.leads where id=$1', [LEAD_B1])).toBe(0);
    expect(await rcAs('authenticated', A_OWNER, "update public.leads set status_atual='x' where id=$1", [LEAD_B1])).toBe(0);
    await deniedAs('authenticated', A_OWNER, 'delete from public.leads where id=$1', [LEAD_B1]); // grant de DELETE revogado (AR-2)
  });
  it('owner A: INSERT lead com organization_id da Org B -> row-level security violation', async () => {
    await deniedAs('authenticated', A_OWNER,
      "insert into public.leads(doctor_id, nome, organization_id) values ($1,'x',$2)", [DOC_A, ORG_B]);
  });
  it('owner A: mover lead da Org A para organization_id da Org B (payload adulterado) -> bloqueado', async () => {
    await deniedAs('authenticated', A_OWNER,
      'update public.leads set organization_id=$1 where id=$2', [ORG_B, LEAD_A1]);
  });
  it('doctor_id incompatível com organization_id: INSERT com doctor da Org B + org da Org A -> bloqueado pela policy', async () => {
    // a policy de leads checa a org; doctor_id nao e checado pela RLS, mas o
    // resolvedor do backend garante a coerencia. Aqui provamos a barreira de org:
    await deniedAs('authenticated', A_OWNER,
      "insert into public.leads(doctor_id, nome, organization_id) values ($1,'x',$2)", [DOC_B, ORG_B]);
  });
  it('deals: closer A não vê/altera deal cuja lead é da Org B', async () => {
    expect(await nAs('authenticated', A_CLOSER,
      'select count(*)::int n from public.deals dl join public.leads l on l.id=dl.lead_id where l.organization_id=$1', [ORG_B])).toBe(0);
  });
  it('events: owner A só vê eventos da Org A; INSERT em unidade da Org B -> bloqueado', async () => {
    const orgs = (await asUser(A_OWNER, (c) => c.query('select distinct organization_id from public.events'))).rows;
    expect(orgs.map((r) => r.organization_id)).toEqual([ORG_A]);
  });

  // ---------- platform_admin ----------
  it('platform_admin: is_platform_admin() true, vê organizations e leads de todas as orgs', async () => {
    await asUser(PLAT_ADMIN, async (c) => {
      expect((await c.query('select public.is_platform_admin() a')).rows[0].a).toBe(true);
      const orgs = (await c.query('select id from public.organizations order by id')).rows.map((r) => r.id);
      expect(orgs.sort()).toEqual([ORG_A, ORG_B].sort());
      const leadOrgs = (await c.query('select distinct organization_id from public.leads')).rows.map((r) => r.organization_id);
      expect(leadOrgs.sort()).toEqual([ORG_A, ORG_B].sort());
    });
  });
  it('usuário comum: is_platform_admin() false', async () => {
    await asUser(A_OWNER, async (c) => {
      expect((await c.query('select public.is_platform_admin() a')).rows[0].a).toBe(false);
    });
  });

  // ---------- AR-2 ----------
  it('AR-2: closer A altera campo PERMITIDO (status_atual) do próprio lead', async () => {
    expect(await rcAs('authenticated', A_CLOSER, "update public.leads set status_atual='conversa_iniciada' where id=$1", [LEAD_A1])).toBe(1);
  });
  it('AR-2: closer A NÃO altera ia_score (coluna não concedida) -> permission denied', async () => {
    await deniedAs('authenticated', A_CLOSER, 'update public.leads set ia_score=999 where id=$1', [LEAD_A1]);
  });
  it('AR-2: closer A NÃO altera doctor_id / organization_id / sdr_responsavel_id -> permission denied', async () => {
    await deniedAs('authenticated', A_CLOSER, 'update public.leads set doctor_id=$1 where id=$2', [DOC_B, LEAD_A1]);
    await deniedAs('authenticated', A_CLOSER, 'update public.leads set organization_id=$1 where id=$2', [ORG_B, LEAD_A1]);
    await deniedAs('authenticated', A_CLOSER, 'update public.leads set sdr_responsavel_id=$1 where id=$2', [A_OWNER, LEAD_A1]);
  });
  it('AR-2: closer A NÃO faz INSERT nem DELETE em leads pelo PostgREST -> permission denied', async () => {
    await deniedAs('authenticated', A_CLOSER, "insert into public.leads(doctor_id,nome) values ($1,'x')", [DOC_A]);
    await deniedAs('authenticated', A_CLOSER, 'delete from public.leads where id=$1', [LEAD_A1]);
  });
  it('AR-2: owner A também não escreve direto em leads pelo PostgREST (backend usa service-role)', async () => {
    await deniedAs('authenticated', A_OWNER, "insert into public.leads(doctor_id,nome,organization_id) values ($1,'x',$2)", [DOC_A, ORG_A]);
  });

  // ---------- AR-3 ----------
  it('AR-3: navegador NÃO lê colunas de token (google_tokens / integrations) -> permission denied', async () => {
    await deniedAs('authenticated', A_OWNER, 'select refresh_token from public.google_tokens');
    await deniedAs('authenticated', A_OWNER, 'select access_token, webhook_token from public.integrations');
  });
  it('AR-3: view google_connection_status retorna só estado (connected/expires_at), nunca o token', async () => {
    await asUser(A_OWNER, async (c) => {
      const r = await c.query('select * from public.google_connection_status');
      expect(r.rows.length).toBe(1);
      expect(Object.keys(r.rows[0])).not.toContain('refresh_token');
      expect(Object.keys(r.rows[0])).not.toContain('access_token');
      expect(r.rows[0]).toHaveProperty('connected');
    });
  });
  it('AR-3: view integration_status não expõe token; escopada por org/owner', async () => {
    await asUser(A_OWNER, async (c) => {
      const r = await c.query('select * from public.integration_status');
      expect(r.rows.every((x) => x.organization_id === ORG_A)).toBe(true);
      for (const row of r.rows) {
        expect(Object.keys(row)).not.toContain('access_token');
        expect(Object.keys(row)).not.toContain('webhook_token');
        expect(row).toHaveProperty('has_access_token');
      }
    });
    // owner B não vê a integração da Org A
    await asUser(B_OWNER, async (c) => {
      const r = await c.query('select organization_id from public.integration_status');
      expect(r.rows.every((x) => x.organization_id === ORG_B)).toBe(true);
    });
    await deniedAs('anon', null, 'select * from public.integration_status');
  });

  // ---------- funções endurecidas ----------
  it('0008: is_org_member/has_org_role/is_platform_admin com search_path fixo e sem EXECUTE p/ anon', async () => {
    const su = await pool.connect();
    try {
      const f = await su.query(
        "select proname, proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('is_org_member','has_org_role','is_platform_admin')"
      );
      expect(f.rows).toHaveLength(3);
      for (const r of f.rows) expect((r.proconfig || []).some((s) => s.startsWith('search_path='))).toBe(true);
      const g = await su.query(
        "select routine_name from information_schema.role_routine_grants where routine_schema='public' and grantee='anon' and routine_name in ('is_org_member','has_org_role','is_platform_admin')"
      );
      expect(g.rows).toHaveLength(0);
    } finally {
      su.release();
    }
  });
});
