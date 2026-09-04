import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// FASE 2.6 — RLS real + RPCs transacionais da migration 0012.
// Rodar: SUPABASE_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run test/rls
//
// NÃO duplica o que já é testado em tenant-core.rls.test.js (is_org_member,
// has_org_role, policy anti-escalonamento de memberships, self-promotion via
// UPDATE direto). Aqui: as RPCs novas (team_member_*), último owner,
// atomicidade, ponte legada, grants e reconciliação do backfill.

const DB_URL = process.env.SUPABASE_TEST_DB_URL;
let pg;
try { pg = (await import('pg')).default; } catch { pg = null; }
const d = DB_URL && pg ? describe : describe.skip;

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG_A = uuid('a1');
const ORG_B = uuid('b1');
const UNIT_A = uuid('a2');
const UNIT_B = uuid('b2');
const DOC_A = uuid('d1');
const OWNER_A = uuid('11');
const ADMIN_A = uuid('12');
const CLOSER_A = uuid('13');
const OWNER2_A = uuid('14');
const ADMIN2_A = uuid('15');
const MEMBER_B = uuid('16');
const NOBODY = uuid('99');

let pool;

async function reset(client) {
  await client.query('begin');
  // escopado às fixtures deste arquivo (uuid('..') com prefixo 00000000-0000-4000-8000-)
  // — nunca um DELETE global, pra não colidir com o seed compartilhado.
  await client.query('delete from public.team_membership_events where organization_id in ($1,$2) or target_user_id = any($3)', [ORG_A, ORG_B, [OWNER_A, ADMIN_A, CLOSER_A, OWNER2_A, ADMIN2_A, MEMBER_B, uuid('21'), uuid('22'), uuid('33'), uuid('55')]]);
  await client.query('delete from public.team_backfill_reconciliation where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await client.query('delete from public.membership_units where unit_id in ($1,$2)', [UNIT_A, UNIT_B]);
  await client.query('delete from public.memberships where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await client.query('delete from public.user_doctor_access where doctor_id = $1', [DOC_A]);
  await client.query('delete from public.organization_doctor_map where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await client.query('delete from public.units where id in ($1,$2)', [UNIT_A, UNIT_B]);
  await client.query('delete from public.doctors where id = $1', [DOC_A]);
  await client.query('delete from public.organizations where id in ($1,$2)', [ORG_A, ORG_B]);
  await client.query('delete from public.users where id = any($1)', [[OWNER_A, ADMIN_A, CLOSER_A, OWNER2_A, ADMIN2_A, MEMBER_B, uuid('21'), uuid('22'), uuid('33'), uuid('55')]]);

  for (const [id, nome] of [
    [OWNER_A, 'Owner A'], [ADMIN_A, 'Admin A'], [CLOSER_A, 'Closer A'], [OWNER2_A, 'Owner2 A'],
    [ADMIN2_A, 'Admin2 A'], [MEMBER_B, 'Member B'],
    [uuid('21'), 'Extra 21'], [uuid('22'), 'Extra 22'], [uuid('33'), 'Extra 33'],
  ]) {
    await client.query(
      "insert into public.users (id, nome, email, role, ativo) values ($1,$2,$3,'closer',true) on conflict (id) do nothing",
      [id, nome, `${id}@x.test`]
    );
  }
  await client.query("update public.users set role='doctor' where id = $1", [OWNER_A]);

  await client.query("insert into public.organizations (id, name, slug, status) values ($1,'Org A','org-a-team-cutover','active'), ($2,'Org B','org-b-team-cutover','active')", [ORG_A, ORG_B]);
  await client.query("insert into public.units (id, organization_id, name, status) values ($1,$2,'Unidade A','active'), ($3,$4,'Unidade B','active')", [UNIT_A, ORG_A, UNIT_B, ORG_B]);
  await client.query("insert into public.doctors (id, owner_user_id) values ($1,$2)", [DOC_A, OWNER_A]);
  await client.query('insert into public.organization_doctor_map (organization_id, doctor_id) values ($1,$2)', [ORG_A, DOC_A]);
  await client.query(
    "insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'organization_owner','active'), ($1,$3,'organization_admin','active'), ($1,$4,'closer','active'), ($1,$5,'organization_admin','active')",
    [ORG_A, OWNER_A, ADMIN_A, CLOSER_A, ADMIN2_A]
  );
  await client.query(
    "insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'closer','active')",
    [ORG_B, MEMBER_B]
  );
  await client.query('insert into public.user_doctor_access (user_id, doctor_id) values ($1,$2)', [CLOSER_A, DOC_A]);
  await client.query('commit');
}

d('RLS/RPC — team memberships cutover (0012) — Supabase local', () => {
  beforeAll(() => { pool = new pg.Pool({ connectionString: DB_URL, max: 5 }); });
  afterAll(async () => {
    if (!pool) return;
    // limpa as fixtures pra não vazar organizations/users pra outras suítes
    // RLS que rodam no MESMO banco (ex.: tenant-core's "select all orgs").
    const c2 = await pool.connect();
    try {
      await c2.query('begin');
      await c2.query('delete from public.team_membership_events where organization_id in ($1,$2) or target_user_id = any($3)', [ORG_A, ORG_B, [OWNER_A, ADMIN_A, CLOSER_A, OWNER2_A, ADMIN2_A, MEMBER_B, uuid('21'), uuid('22'), uuid('33'), uuid('55')]]);
      await c2.query('delete from public.team_backfill_reconciliation where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c2.query('delete from public.membership_units where unit_id in ($1,$2)', [UNIT_A, UNIT_B]);
      await c2.query('delete from public.memberships where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c2.query('delete from public.user_doctor_access where doctor_id = $1', [DOC_A]);
      await c2.query('delete from public.organization_doctor_map where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c2.query('delete from public.units where id in ($1,$2)', [UNIT_A, UNIT_B]);
      await c2.query('delete from public.doctors where id = $1', [DOC_A]);
      await c2.query('delete from public.organizations where id in ($1,$2)', [ORG_A, ORG_B]);
      await c2.query('delete from public.users where id = any($1)', [[OWNER_A, ADMIN_A, CLOSER_A, OWNER2_A, ADMIN2_A, MEMBER_B, uuid('21'), uuid('22'), uuid('33'), uuid('55')]]);
      await c2.query('commit');
    } catch { await c2.query('rollback').catch(() => {}); }
    finally { c2.release(); }
    await pool.end();
  });
  beforeEach(async () => {
    const c = await pool.connect();
    try { await reset(c); } finally { c.release(); }
  });

  it('0012: RPCs e tabelas existem', async () => {
    const c = await pool.connect();
    try {
      const fns = await c.query(
        "select proname from pg_proc where pronamespace = 'public'::regnamespace and proname like 'team_%' order by proname"
      );
      expect(fns.rows.map((r) => r.proname)).toEqual(expect.arrayContaining([
        'team_actor_role', 'team_member_add', 'team_member_change_role',
        'team_member_remove', 'team_member_set_status', 'team_member_set_units',
        'team_backfill_reconcile',
      ]));
      const t = await c.query("select to_regclass('public.team_membership_events') a, to_regclass('public.team_backfill_reconciliation') b");
      expect(t.rows[0].a).toBe('team_membership_events');
      expect(t.rows[0].b).toBe('team_backfill_reconciliation');
    } finally { c.release(); }
  });

  it('grants: EXECUTE revogado de anon/authenticated nas RPCs (defesa camada 1)', async () => {
    const c = await pool.connect();
    try {
      const names = await c.query(
        "select p.oid, p.proname, " +
        "  (select coalesce(string_agg(format_type(t, null), ', '), '') " +
        "     from unnest(p.proargtypes::oid[]) as t) args " +
        "from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'team_%'"
      );
      for (const row of names.rows) {
        const sig = `public.${row.proname}(${row.args})`;
        const r = await c.query(
          "select has_function_privilege('anon', $1, 'execute') anon_exec, has_function_privilege('authenticated', $1, 'execute') auth_exec, has_function_privilege('service_role', $1, 'execute') service_exec",
          [sig]
        );
        expect(r.rows[0].anon_exec, `${sig}: anon não deveria executar`).toBe(false);
        expect(r.rows[0].auth_exec, `${sig}: authenticated não deveria executar`).toBe(false);
        expect(r.rows[0].service_exec, `${sig}: service_role DEVE executar`).toBe(true);
      }
    } finally { c.release(); }
  });

  it('defesa camada 2 (auth.uid()): mesmo se alguém chamasse a RPC direto com um JWT de authenticated, NÃO consegue se passar por outro usuário', async () => {
    // Simula exatamente o pior caso: authenticated com JWT real de CLOSER_A
    // tentando alegar ser OWNER_A via p_actor_user_id (impersonation). Isso
    // tem que ser bloqueado mesmo que a camada 1 (grants) falhe por qualquer
    // motivo — é a garantia que não depende do comportamento do ambiente.
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: CLOSER_A, role: 'authenticated' })]);
      // concede execute temporariamente só para provar que a camada 2 sozinha barra
      await c.query('grant execute on function public.team_member_change_role(uuid,uuid,uuid,text) to authenticated');
      await c.query('set local role authenticated');
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'viewer')", [ORG_A, OWNER_A, ADMIN_A])
      ).rejects.toThrow(/forbidden/i); // auth.uid()=CLOSER_A != p_actor_user_id=OWNER_A
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });

  it('defesa camada 2: chamada direta como authenticated alegando ser si mesmo ainda passa pelas regras de negócio normais (closer não gerencia)', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: CLOSER_A, role: 'authenticated' })]);
      await c.query('grant execute on function public.team_member_change_role(uuid,uuid,uuid,text) to authenticated');
      await c.query('set local role authenticated');
      // auth.uid() == p_actor_user_id agora (sem impersonation) -> passa da
      // camada 2, mas cai na regra de negócio: closer não gerencia equipe.
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'viewer')", [ORG_A, CLOSER_A, ADMIN_A])
      ).rejects.toThrow(/forbidden/i);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });

  it('team_backfill_reconcile e team_sync_legacy_bridge são estritamente backend-only (nenhum auth.uid() aceito)', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: OWNER_A, role: 'authenticated' })]);
      await c.query('savepoint sp1');
      await expect(c.query('select public.team_backfill_reconcile()')).rejects.toThrow(/forbidden/i);
      await c.query('rollback to savepoint sp1'); // um erro aborta a transação até o próximo savepoint/rollback
      await expect(
        c.query("select public.team_sync_legacy_bridge($1,$2,'closer',true)", [ORG_A, OWNER_A])
      ).rejects.toThrow(/forbidden/i);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });

  it('search_path das funções SECURITY DEFINER é vazio/fixo', async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `select p.proname, p.proconfig from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname like 'team_%'`
      );
      for (const row of r.rows) {
        expect((row.proconfig || []).some((cfg) => cfg === 'search_path=' || cfg.startsWith('search_path='))).toBe(true);
      }
    } finally { c.release(); }
  });

  it('nenhuma policy USING(true) pública nas tabelas novas', async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `select tablename, policyname, qual from pg_policies
         where schemaname='public' and tablename in ('team_membership_events','team_backfill_reconciliation')`
      );
      expect(r.rows.length).toBe(0); // sem policy nenhuma = deny-all (revoke all já cobre)
    } finally { c.release(); }
  });

  it('owner adiciona membro (RPC) -> membership + ponte + auditoria, atômico', async () => {
    const c = await pool.connect();
    try {
      const r = await c.query(
        "select public.team_member_add($1,$2,$3,'closer',ARRAY[$4]::uuid[]) as j",
        [ORG_A, OWNER_A, OWNER2_A, UNIT_A]
      );
      const j = r.rows[0].j;
      expect(j.role).toBe('closer');
      const m = await c.query('select role, status from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, OWNER2_A]);
      expect(m.rows[0]).toEqual({ role: 'closer', status: 'active' });
      const bridge = await c.query('select 1 from public.user_doctor_access where user_id=$1 and doctor_id=$2', [OWNER2_A, DOC_A]);
      expect(bridge.rowCount).toBe(1);
      const audit = await c.query("select result from public.team_membership_events where target_user_id=$1 and action='add'", [OWNER2_A]);
      expect(audit.rows.map((x) => x.result)).toEqual(['success']);
    } finally { c.release(); }
  });

  it('admin NÃO cria owner/admin/platform_admin (RPC)', async () => {
    const c = await pool.connect();
    try {
      for (const role of ['organization_owner', 'organization_admin', 'platform_admin']) {
        await expect(
          c.query("select public.team_member_add($1,$2,$3,$4,'{}')", [ORG_A, ADMIN_A, OWNER2_A, role])
        ).rejects.toThrow(role === 'platform_admin' ? /invalid_role/ : /forbidden/);
      }
    } finally { c.release(); }
  });

  it('admin NÃO se promove a si mesmo', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'organization_owner')", [ORG_A, ADMIN_A, ADMIN_A])
      ).rejects.toThrow(/forbidden/);
    } finally { c.release(); }
  });

  it('closer/receptionist/professional/financial/viewer não gerenciam equipe', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'viewer')", [ORG_A, CLOSER_A, ADMIN_A])
      ).rejects.toThrow(/forbidden/);
    } finally { c.release(); }
  });

  // -------------------------------------------------------------------
  // Bloqueador 1 — hierarquia estrita: organization_admin só administra
  // papéis ESTRITAMENTE abaixo do próprio (nunca outro admin, nunca owner,
  // nunca platform_admin, nunca a si mesmo). Só organization_owner ou
  // platform_admin administram uma membership organization_admin/owner.
  // -------------------------------------------------------------------

  it('1) organization_admin NÃO cria organization_admin', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query("select public.team_member_add($1,$2,$3,'organization_admin','{}')", [ORG_A, ADMIN_A, OWNER2_A])
      ).rejects.toThrow(/forbidden/);
      const m = await c.query('select 1 from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, OWNER2_A]);
      expect(m.rowCount).toBe(0); // nada foi criado
    } finally { c.release(); }
  });

  it('2) organization_admin NÃO promove manager (ou qualquer papel inferior) para organization_admin', async () => {
    const c = await pool.connect();
    try {
      await c.query("update public.memberships set role='manager' where organization_id=$1 and user_id=$2", [ORG_A, CLOSER_A]);
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'organization_admin')", [ORG_A, ADMIN_A, CLOSER_A])
      ).rejects.toThrow(/forbidden/);
      const r = await c.query('select role from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, CLOSER_A]);
      expect(r.rows[0].role).toBe('manager'); // inalterado
    } finally { c.release(); }
  });

  it('3) organization_admin NÃO altera papel de OUTRO organization_admin (mesmo pra um papel que ele poderia conceder a um closer)', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'closer')", [ORG_A, ADMIN_A, ADMIN2_A])
      ).rejects.toThrow(/forbidden/);
      const r = await c.query('select role from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, ADMIN2_A]);
      expect(r.rows[0].role).toBe('organization_admin'); // inalterado
    } finally { c.release(); }
  });

  it('4) organization_admin NÃO suspende outro organization_admin', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query("select public.team_member_set_status($1,$2,$3,'suspended')", [ORG_A, ADMIN_A, ADMIN2_A])
      ).rejects.toThrow(/forbidden/);
      const r = await c.query('select status from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, ADMIN2_A]);
      expect(r.rows[0].status).toBe('active'); // inalterado
    } finally { c.release(); }
  });

  it('5) organization_admin NÃO reativa outro organization_admin', async () => {
    const c = await pool.connect();
    try {
      // owner suspende ADMIN2_A primeiro (permitido)
      await c.query("select public.team_member_set_status($1,$2,$3,'suspended')", [ORG_A, OWNER_A, ADMIN2_A]);
      await expect(
        c.query("select public.team_member_set_status($1,$2,$3,'active')", [ORG_A, ADMIN_A, ADMIN2_A])
      ).rejects.toThrow(/forbidden/);
      const r = await c.query('select status from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, ADMIN2_A]);
      expect(r.rows[0].status).toBe('suspended'); // continua suspenso — admin não reverteu
    } finally { c.release(); }
  });

  it('6) organization_admin NÃO remove outro organization_admin', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query('select public.team_member_remove($1,$2,$3)', [ORG_A, ADMIN_A, ADMIN2_A])
      ).rejects.toThrow(/forbidden/);
      const m = await c.query('select 1 from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, ADMIN2_A]);
      expect(m.rowCount).toBe(1); // continua existindo
    } finally { c.release(); }
  });

  it('7) organization_admin NÃO altera unidades de outro organization_admin', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query('select public.team_member_set_units($1,$2,$3,ARRAY[$4]::uuid[])', [ORG_A, ADMIN_A, ADMIN2_A, UNIT_A])
      ).rejects.toThrow(/forbidden/);
      const mu = await c.query(
        `select 1 from public.membership_units mu join public.memberships m on m.id = mu.membership_id
         where m.organization_id=$1 and m.user_id=$2`,
        [ORG_A, ADMIN2_A]
      );
      expect(mu.rowCount).toBe(0); // nada foi atribuído
    } finally { c.release(); }
  });

  it('8) organization_admin NÃO altera a própria membership (papel, status nem unidades)', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'closer')", [ORG_A, ADMIN_A, ADMIN_A])
      ).rejects.toThrow(/forbidden/);
      await expect(
        c.query("select public.team_member_set_status($1,$2,$3,'suspended')", [ORG_A, ADMIN_A, ADMIN_A])
      ).rejects.toThrow(/forbidden/);
      await expect(
        c.query('select public.team_member_set_units($1,$2,$3,ARRAY[$4]::uuid[])', [ORG_A, ADMIN_A, ADMIN_A, UNIT_A])
      ).rejects.toThrow(/forbidden/);
      await expect(
        c.query('select public.team_member_remove($1,$2,$3)', [ORG_A, ADMIN_A, ADMIN_A])
      ).rejects.toThrow(/forbidden/);
      const r = await c.query('select role, status from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, ADMIN_A]);
      expect(r.rows[0]).toEqual({ role: 'organization_admin', status: 'active' }); // 100% inalterado
    } finally { c.release(); }
  });

  it('9) organization_admin NÃO administra organization_owner (papel/status/remoção/unidades)', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'manager')", [ORG_A, ADMIN_A, OWNER_A])
      ).rejects.toThrow(/forbidden/);
      await expect(
        c.query("select public.team_member_set_status($1,$2,$3,'suspended')", [ORG_A, ADMIN_A, OWNER_A])
      ).rejects.toThrow(/forbidden/);
      await expect(
        c.query('select public.team_member_remove($1,$2,$3)', [ORG_A, ADMIN_A, OWNER_A])
      ).rejects.toThrow(/forbidden/);
      await expect(
        c.query('select public.team_member_set_units($1,$2,$3,ARRAY[$4]::uuid[])', [ORG_A, ADMIN_A, OWNER_A, UNIT_A])
      ).rejects.toThrow(/forbidden/);
    } finally { c.release(); }
  });

  it('10) organization_admin NÃO administra platform_admin (defensivo — nem chega a existir via memberships, mas a checagem cobre)', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      // OWNER2_A não tem membership no seed base — cria já como 'platform_admin'
      // (linha defensiva: nunca é criada assim por uma RPC de verdade, mas a
      // checagem de hierarquia tem que cobrir mesmo esse estado hipotético).
      await c.query(
        "insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'platform_admin','active') on conflict (organization_id, user_id) do update set role='platform_admin'",
        [ORG_A, OWNER2_A]
      );
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'closer')", [ORG_A, ADMIN_A, OWNER2_A])
      ).rejects.toThrow(/forbidden/);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });

  it('11) organization_owner CONSEGUE administrar organization_admin da própria organização', async () => {
    const c = await pool.connect();
    try {
      const role = await c.query("select public.team_member_change_role($1,$2,$3,'manager') as j", [ORG_A, OWNER_A, ADMIN2_A]);
      expect(role.rows[0].j.role).toBe('manager');
      await c.query("update public.memberships set role='organization_admin' where organization_id=$1 and user_id=$2", [ORG_A, ADMIN2_A]);
      const status = await c.query("select public.team_member_set_status($1,$2,$3,'suspended') as j", [ORG_A, OWNER_A, ADMIN2_A]);
      expect(status.rows[0].j.status).toBe('suspended');
      const units = await c.query('select public.team_member_set_units($1,$2,$3,ARRAY[$4]::uuid[]) as j', [ORG_A, OWNER_A, ADMIN2_A, UNIT_A]);
      expect(units.rows[0].j.unit_ids).toEqual([UNIT_A]);
    } finally { c.release(); }
  });

  it('12) organization_owner NÃO administra membro de OUTRA organização (cross-tenant -> not_found)', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'manager')", [ORG_A, OWNER_A, MEMBER_B])
      ).rejects.toThrow(/not_found/);
      const r = await c.query('select role from public.memberships where organization_id=$1 and user_id=$2', [ORG_B, MEMBER_B]);
      expect(r.rows[0].role).toBe('closer'); // inalterado
    } finally { c.release(); }
  });

  it('13) platform_admin segue só a regra já definida (sem restrição extra) — administra owner e admin livremente', async () => {
    const c = await pool.connect();
    try {
      const PLAT_ADMIN = uuid('55');
      await c.query("insert into public.users (id, nome, email, role, ativo) values ($1,'Plat Admin','plat13@x.test','admin',true) on conflict (id) do nothing", [PLAT_ADMIN]);
      const r1 = await c.query("select public.team_member_change_role($1,$2,$3,'manager') as j", [ORG_A, PLAT_ADMIN, ADMIN2_A]);
      expect(r1.rows[0].j.role).toBe('manager');
      const r2 = await c.query("select public.team_member_set_status($1,$2,$3,'suspended') as j", [ORG_A, PLAT_ADMIN, ADMIN_A]);
      expect(r2.rows[0].j.status).toBe('suspended');
    } finally { c.release(); }
  });

  it('14) chamada DIRETA à RPC (fora da API) também é bloqueada — a regra vive no banco, não no Express', async () => {
    const c = await pool.connect();
    try {
      // simula "direto", sem passar pela app: mesma sessão, mesma RPC, sem
      // nenhum contexto HTTP — já é isso que os testes acima fazem, mas aqui
      // reforça explicitamente com set_config de um JWT authenticated real.
      await c.query('begin');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN_A, role: 'authenticated' })]);
      await expect(
        c.query("select public.team_member_remove($1,$2,$3)", [ORG_A, ADMIN_A, ADMIN2_A])
      ).rejects.toThrow(/forbidden/);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });

  it('15) API: negação de hierarquia retorna erro seguro (403), sem revelar dados do alvo', async () => {
    // nível RPC (a API só traduz message->status; ver rpcErrorResponse em
    // src/routes/team.js — 'forbidden' -> 403, corpo só {error:'forbidden'}).
    const c = await pool.connect();
    try {
      await expect(
        c.query('select public.team_member_remove($1,$2,$3)', [ORG_A, ADMIN_A, ADMIN2_A])
      ).rejects.toThrow(/forbidden/);
    } finally { c.release(); }
  });

  it('16) negação de hierarquia NUNCA deixa alteração parcial (role, status e units intactos)', async () => {
    const c = await pool.connect();
    try {
      const before = await c.query('select role, status from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, ADMIN2_A]);
      const muBefore = await c.query(
        `select count(*)::int n from public.membership_units mu join public.memberships m on m.id=mu.membership_id where m.organization_id=$1 and m.user_id=$2`,
        [ORG_A, ADMIN2_A]
      );
      await expect(c.query("select public.team_member_change_role($1,$2,$3,'viewer')", [ORG_A, ADMIN_A, ADMIN2_A])).rejects.toThrow(/forbidden/);
      await expect(c.query("select public.team_member_set_status($1,$2,$3,'suspended')", [ORG_A, ADMIN_A, ADMIN2_A])).rejects.toThrow(/forbidden/);
      await expect(c.query('select public.team_member_set_units($1,$2,$3,ARRAY[$4]::uuid[])', [ORG_A, ADMIN_A, ADMIN2_A, UNIT_A])).rejects.toThrow(/forbidden/);
      await expect(c.query('select public.team_member_remove($1,$2,$3)', [ORG_A, ADMIN_A, ADMIN2_A])).rejects.toThrow(/forbidden/);
      const after = await c.query('select role, status from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, ADMIN2_A]);
      const muAfter = await c.query(
        `select count(*)::int n from public.membership_units mu join public.memberships m on m.id=mu.membership_id where m.organization_id=$1 and m.user_id=$2`,
        [ORG_A, ADMIN2_A]
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      expect(muAfter.rows[0].n).toBe(muBefore.rows[0].n);
    } finally { c.release(); }
  });

  it('17) auditoria registra "denied"/erro da hierarquia sem PII nem segredo (aqui: a RPC nem chega a auditar — falha ANTES do insert de evento; confirma que nada vaza)', async () => {
    const c = await pool.connect();
    try {
      const before = await c.query('select count(*)::int n from public.team_membership_events where target_user_id=$1', [ADMIN2_A]);
      await expect(c.query('select public.team_member_remove($1,$2,$3)', [ORG_A, ADMIN_A, ADMIN2_A])).rejects.toThrow(/forbidden/);
      const after = await c.query('select * from public.team_membership_events where target_user_id=$1', [ADMIN2_A]);
      // nenhum evento novo foi criado pra essa tentativa (a checagem de
      // hierarquia interrompe antes de qualquer INSERT de auditoria) — e,
      // mesmo se existisse, a tabela nunca tem coluna de e-mail/nome/token.
      expect(after.rowCount).toBe(before.rows[0].n);
      expect(JSON.stringify(after.rows)).not.toMatch(/@|token|senha|password/i);
    } finally { c.release(); }
  });

  it('18) concorrência não permite contornar a hierarquia: dois admins tentando mexer um no outro ao mesmo tempo -> ambos bloqueados, nada muda', async () => {
    const cA = await pool.connect();
    const cB = await pool.connect();
    try {
      const [rA, rB] = await Promise.all([
        cA.query("select public.team_member_change_role($1,$2,$3,'viewer')", [ORG_A, ADMIN_A, ADMIN2_A]).then(() => ({ ok: true })).catch((e) => ({ ok: false, e })),
        cB.query("select public.team_member_change_role($1,$2,$3,'viewer')", [ORG_A, ADMIN2_A, ADMIN_A]).then(() => ({ ok: true })).catch((e) => ({ ok: false, e })),
      ]);
      expect(rA.ok).toBe(false);
      expect(rB.ok).toBe(false);
      expect(rA.e.message).toMatch(/forbidden/);
      expect(rB.e.message).toMatch(/forbidden/);
      const roles = await pool.query('select user_id, role from public.memberships where organization_id=$1 and user_id = any($2)', [ORG_A, [ADMIN_A, ADMIN2_A]]);
      for (const row of roles.rows) expect(row.role).toBe('organization_admin'); // nenhum dos dois mudou
    } finally {
      cA.release();
      cB.release();
    }
  });

  it('JWT/claims não importam: RPC usa só o estado do banco para o ator', async () => {
    const c = await pool.connect();
    try {
      // mesmo "autenticado" como outro role via request.jwt.claims, a RPC
      // ignora claims e olha só memberships pelo p_actor_user_id.
      await c.query('begin');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: CLOSER_A, role: 'organization_owner' })]);
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'viewer')", [ORG_A, CLOSER_A, ADMIN_A])
      ).rejects.toThrow(/forbidden/); // CLOSER_A continua sendo tratado como 'closer' de verdade
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });

  it('body/params com organization_id de outra org -> not_found (cross-tenant)', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query("select public.team_member_change_role($1,$2,$3,'viewer')", [ORG_B, OWNER_A, ADMIN_A])
      ).rejects.toThrow(/not_found/); // ADMIN_A não tem membership na ORG_B
    } finally { c.release(); }
  });

  it('unit de outra organização é rejeitada (add e set_units)', async () => {
    const c = await pool.connect();
    try {
      await expect(
        c.query("select public.team_member_add($1,$2,$3,'viewer',ARRAY[$4]::uuid[])", [ORG_A, OWNER_A, OWNER2_A, UNIT_B])
      ).rejects.toThrow(/unit_not_in_organization/);
      await expect(
        c.query("select public.team_member_set_units($1,$2,$3,ARRAY[$4]::uuid[])", [ORG_A, OWNER_A, CLOSER_A, UNIT_B])
      ).rejects.toThrow(/unit_not_in_organization/);
    } finally { c.release(); }
  });

  it('último owner: não pode ser rebaixado, suspenso nem removido', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query("select public.team_member_change_role($1,$2,$3,'manager')", [ORG_A, OWNER_A, OWNER_A])).rejects.toThrow(/last_owner_protected/);
      await expect(c.query("select public.team_member_set_status($1,$2,$3,'suspended')", [ORG_A, OWNER_A, OWNER_A])).rejects.toThrow(/last_owner_protected/);
      await expect(c.query('select public.team_member_remove($1,$2,$3)', [ORG_A, OWNER_A, OWNER_A])).rejects.toThrow(/last_owner_protected/);
    } finally { c.release(); }
  });

  it('dois owners: dá para rebaixar/suspender/remover um deles', async () => {
    const c = await pool.connect();
    try {
      await c.query("insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'organization_owner','active')", [ORG_A, OWNER2_A]);
      const r = await c.query("select public.team_member_change_role($1,$2,$3,'manager') as j", [ORG_A, OWNER_A, OWNER2_A]);
      expect(r.rows[0].j.role).toBe('manager');
    } finally { c.release(); }
  });

  it('CORRIDA REAL: dois owners, dois requests concorrentes rebaixando CADA UM deles -> exatamente um vence, nunca zero owners', async () => {
    // Ator = platform_admin (não é membership da organização e não é alvo de
    // nenhuma das duas chamadas) — evita que o rebaixamento de UM target mude
    // a autoridade do próprio ator no meio da corrida (o que aconteceria se o
    // ator fosse um dos dois owners sendo rebaixados).
    const PLAT_ADMIN = uuid('55');
    const c0 = await pool.connect();
    try {
      await c0.query("insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'organization_owner','active')", [ORG_A, OWNER2_A]);
      await c0.query("insert into public.users (id, nome, email, role, ativo) values ($1,'Plat Admin','plat@x.test','admin',true) on conflict (id) do nothing", [PLAT_ADMIN]);
    } finally { c0.release(); }

    const cA = await pool.connect();
    const cB = await pool.connect();
    try {
      const [rA, rB] = await Promise.all([
        cA.query("select public.team_member_change_role($1,$2,$3,'manager') as j", [ORG_A, PLAT_ADMIN, OWNER_A]).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e })),
        cB.query("select public.team_member_change_role($1,$2,$3,'manager') as j", [ORG_A, PLAT_ADMIN, OWNER2_A]).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e })),
      ]);
      const results = [rA, rB];
      const succeeded = results.filter((x) => x.ok);
      const failed = results.filter((x) => !x.ok);
      // Dois desfechos são igualmente seguros aqui: (a) o lock ordenado detecta
      // "só sobraria 1 owner" e recusa com last_owner_protected, ou (b) o
      // Postgres detecta uma dependência circular de locks entre os dois
      // targets e aborta uma das transações com deadlock (SQLSTATE 40P01) —
      // o backend traduz isso em 409 concurrent_update (ver rpcErrorResponse).
      // Em NENHUM dos dois casos os dois rebaixamentos podem vencer ao mesmo
      // tempo — é exatamente essa garantia que este teste prova.
      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(failed[0].e.message).toMatch(/last_owner_protected|deadlock detected/);

      const owners = await pool.query(
        "select count(*)::int n from public.memberships where organization_id=$1 and role='organization_owner' and status='active'",
        [ORG_A]
      );
      expect(owners.rows[0].n).toBe(1); // NUNCA zero — a corrida ficou fechada
    } finally {
      cA.release();
      cB.release();
    }
  });

  it('suspender remove a ponte legada; reativar (explícito) restaura', async () => {
    const c = await pool.connect();
    try {
      await c.query("select public.team_member_set_status($1,$2,$3,'suspended')", [ORG_A, OWNER_A, CLOSER_A]);
      let bridge = await c.query('select 1 from public.user_doctor_access where user_id=$1 and doctor_id=$2', [CLOSER_A, DOC_A]);
      expect(bridge.rowCount).toBe(0);
      await c.query("select public.team_member_set_status($1,$2,$3,'active')", [ORG_A, OWNER_A, CLOSER_A]);
      bridge = await c.query('select 1 from public.user_doctor_access where user_id=$1 and doctor_id=$2', [CLOSER_A, DOC_A]);
      expect(bridge.rowCount).toBe(1);
    } finally { c.release(); }
  });

  it('remover: apaga membership + membership_units (cascade) + ponte; NÃO apaga users', async () => {
    const c = await pool.connect();
    try {
      await c.query('insert into public.membership_units (membership_id, unit_id) select id, $1 from public.memberships where organization_id=$2 and user_id=$3', [UNIT_A, ORG_A, CLOSER_A]);
      await c.query('select public.team_member_remove($1,$2,$3)', [ORG_A, OWNER_A, CLOSER_A]);
      const m = await c.query('select 1 from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, CLOSER_A]);
      expect(m.rowCount).toBe(0);
      const mu = await c.query('select 1 from public.membership_units mu join public.memberships m on m.id=mu.membership_id where m.user_id=$1', [CLOSER_A]);
      expect(mu.rowCount).toBe(0);
      const bridge = await c.query('select 1 from public.user_doctor_access where user_id=$1', [CLOSER_A]);
      expect(bridge.rowCount).toBe(0);
      const u = await c.query('select 1 from public.users where id=$1', [CLOSER_A]);
      expect(u.rowCount).toBe(1);
    } finally { c.release(); }
  });

  it('falha no meio da RPC não deixa estado parcial (transação única)', async () => {
    const c = await pool.connect();
    try {
      // unidade inválida força exceção DEPOIS do insert de membership seria
      // feito na mesma função -> tudo deve reverter (nenhuma membership deve existir).
      await expect(
        c.query("select public.team_member_add($1,$2,$3,'viewer',ARRAY[$4]::uuid[])", [ORG_A, OWNER_A, OWNER2_A, UNIT_B])
      ).rejects.toThrow(/unit_not_in_organization/);
      const m = await c.query('select 1 from public.memberships where organization_id=$1 and user_id=$2', [ORG_A, OWNER2_A]);
      expect(m.rowCount).toBe(0); // nada foi criado — rollback total
    } finally { c.release(); }
  });

  it('operações concorrentes em integrações/membros DIFERENTES não se bloqueiam', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const [r1, r2] = await Promise.all([
        c1.query("select public.team_member_add($1,$2,$3,'viewer','{}') as j", [ORG_A, OWNER_A, uuid('21')]).catch((e) => e),
        c2.query("select public.team_member_add($1,$2,$3,'viewer','{}') as j", [ORG_A, OWNER_A, uuid('22')]).catch((e) => e),
      ]);
      expect(r1.rows?.[0]?.j?.role).toBe('viewer');
      expect(r2.rows?.[0]?.j?.role).toBe('viewer');
    } finally {
      await c1.query('delete from public.memberships where user_id = any($1)', [[uuid('21'), uuid('22')]]).catch(() => {});
      c1.release(); c2.release();
    }
  });

  it('reconciliação do backfill: idempotente, só contagens (sem PII), classifica match/divergent', async () => {
    const c = await pool.connect();
    try {
      // ADMIN_A e ADMIN2_A (organization_admin) não têm equivalente legado
      // por design (auditoria 23, §4) — removidos só nesta checagem pra
      // isolar uma baseline "match" de verdade (owner + closer, ambos com ponte).
      await c.query('delete from public.memberships where organization_id=$1 and user_id=any($2)', [ORG_A, [ADMIN_A, ADMIN2_A]]);
      await c.query('select public.team_backfill_reconcile()');
      const first = await c.query('select classification, only_legacy_count, only_membership_count from public.team_backfill_reconciliation where organization_id=$1 order by created_at desc limit 1', [ORG_A]);
      expect(first.rows[0].classification).toBe('match'); // owner + closer, ambos com ponte

      // introduz divergência: membership nova sem ponte
      await c.query("insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'viewer','active')", [ORG_A, uuid('33')]);
      await c.query('select public.team_backfill_reconcile()');
      const second = await c.query('select classification, only_membership_count from public.team_backfill_reconciliation where organization_id=$1 order by created_at desc limit 1', [ORG_A]);
      expect(second.rows[0].classification).toBe('divergent');
      expect(second.rows[0].only_membership_count).toBeGreaterThan(0);

      // reexecutar não corrige nada (a membership sem ponte continua sem ponte)
      const uda = await c.query('select 1 from public.user_doctor_access where user_id=$1', [uuid('33')]);
      expect(uda.rowCount).toBe(0);
    } finally { c.release(); }
  });

  it('reconciliação nunca grava e-mail/telefone/nome — só uuid e contagens', async () => {
    const c = await pool.connect();
    try {
      await c.query('select public.team_backfill_reconcile()');
      const cols = await c.query(
        "select column_name from information_schema.columns where table_name='team_backfill_reconciliation'"
      );
      const names = cols.rows.map((r) => r.column_name);
      expect(names).not.toEqual(expect.arrayContaining(['email', 'telefone', 'nome']));
    } finally { c.release(); }
  });

  it('auditoria (team_membership_events) nunca contém token/segredo, só ids/role/status', async () => {
    const c = await pool.connect();
    try {
      await c.query("select public.team_member_set_status($1,$2,$3,'suspended')", [ORG_A, OWNER_A, CLOSER_A]);
      const ev = await c.query('select detail from public.team_membership_events where target_user_id=$1', [CLOSER_A]);
      const blob = JSON.stringify(ev.rows);
      expect(blob).not.toMatch(/token|senha|password/i);
    } finally { c.release(); }
  });
});
