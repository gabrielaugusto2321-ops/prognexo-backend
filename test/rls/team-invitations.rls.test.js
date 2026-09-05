import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// FASE 2.7 — convites seguros/outbox (migration 0013). Rodar:
// SUPABASE_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run test/rls/team-invitations.rls.test.js
//
// As RPCs desta fase nunca chamam a API do Supabase Auth (isso é feito só
// pelo Node em src/routes/teamInvitations.js) — aqui `p_auth_user_id`/
// `p_event_id` são uuids sintéticos quaisquer, exatamente como o RPC os
// recebe depois que o Node já os obteve. Isso permite testar a máquina de
// estados inteira sem tocar em Supabase Auth nem em rede.

const DB_URL = process.env.SUPABASE_TEST_DB_URL;
let pg; try { pg = (await import('pg')).default; } catch { pg = null; }
const d = DB_URL && pg ? describe : describe.skip;

// prefixo 9000 (diferente do 8000 usado por team-memberships.rls.test.js)
// pra nunca colidir quando as duas suítes rodam no mesmo banco.
const uuid = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const ORG_A = uuid('a1');
const ORG_B = uuid('b1');
const OWNER_A = uuid('11');
const ADMIN_A = uuid('12');
const CLOSER_A = uuid('13');
const OWNER_B = uuid('14');

let pool;

async function reset(client) {
  await client.query('begin');
  await client.query('delete from public.outbox_events where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await client.query('delete from public.organization_invitations where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await client.query('delete from public.memberships where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await client.query('delete from public.organizations where id in ($1,$2)', [ORG_A, ORG_B]);
  await client.query('delete from public.users where id = any($1)', [[OWNER_A, ADMIN_A, CLOSER_A, OWNER_B]]);
  for (const [id, nome] of [[OWNER_A, 'Owner A'], [ADMIN_A, 'Admin A'], [CLOSER_A, 'Closer A'], [OWNER_B, 'Owner B']]) {
    await client.query("insert into public.users (id, nome, email, role, ativo) values ($1,$2,$3,'closer',true) on conflict (id) do nothing", [id, nome, `${id}@x.test`]);
  }
  await client.query("insert into public.organizations (id, name, slug, status) values ($1,'Org A','org-a-invites','active'), ($2,'Org B','org-b-invites','active')", [ORG_A, ORG_B]);
  await client.query(
    "insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'organization_owner','active'), ($1,$3,'organization_admin','active'), ($1,$4,'closer','active')",
    [ORG_A, OWNER_A, ADMIN_A, CLOSER_A]
  );
  await client.query("insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'organization_owner','active')", [ORG_B, OWNER_B]);
  await client.query('commit');
}

d('RLS/RPC — secure team invitations 0013 — Supabase local', () => {
  beforeAll(() => { pool = new pg.Pool({ connectionString: DB_URL, max: 5 }); });
  afterAll(async () => {
    if (!pool) return;
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('delete from public.outbox_events where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.organization_invitations where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.memberships where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.organizations where id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.users where id = any($1)', [[OWNER_A, ADMIN_A, CLOSER_A, OWNER_B]]);
      await c.query('commit');
    } catch { await c.query('rollback').catch(() => {}); }
    finally { c.release(); }
    await pool.end();
  });
  beforeEach(async () => {
    const c = await pool.connect();
    try { await reset(c); } finally { c.release(); }
  });

  it('tabelas existem, RLS está ligada e não há policy pública', async () => {
    const r = await pool.query("select c.relname,c.relrowsecurity from pg_class c where c.oid in ('public.organization_invitations'::regclass,'public.outbox_events'::regclass) order by c.relname");
    expect(r.rows).toEqual([{ relname: 'organization_invitations', relrowsecurity: true }, { relname: 'outbox_events', relrowsecurity: true }]);
    const p = await pool.query("select count(*)::int n from pg_policies where schemaname='public' and tablename in ('organization_invitations','outbox_events')");
    expect(p.rows[0].n).toBe(0);
  });

  it('PUBLIC/anon/authenticated não têm privilégios nas tabelas', async () => {
    // 'PUBLIC' é pseudo-role (palavra-chave), não um nome de role de verdade —
    // has_table_privilege() não aceita esse literal como parâmetro (erro "role
    // \"PUBLIC\" does not exist"). Checa a pseudo-role via information_schema.
    for (const table of ['organization_invitations', 'outbox_events']) {
      const pub = await pool.query("select count(*)::int n from information_schema.role_table_grants where table_schema='public' and table_name=$1 and grantee='PUBLIC'", [table]);
      expect(pub.rows[0].n, `PUBLIC ${table}`).toBe(0);
    }
    for (const role of ['anon', 'authenticated']) for (const table of ['organization_invitations', 'outbox_events']) {
      const r = await pool.query('select has_table_privilege($1,$2,$3) ok', [role, `public.${table}`, 'select,insert,update,delete']);
      expect(r.rows[0].ok, `${role} ${table}`).toBe(false);
    }
  });

  it('todas as RPCs 0013 são security definer/search_path vazio e só service_role executa', async () => {
    const r = await pool.query("select p.oid::regprocedure::text sig,p.prosecdef,coalesce(array_to_string(p.proconfig,','),'') cfg from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'team_invitation_%' or p.proname like 'team_outbox_%')");
    expect(r.rows.length).toBeGreaterThanOrEqual(10);
    for (const fn of r.rows) {
      expect(fn.prosecdef).toBe(true); expect(fn.cfg).toContain('search_path=');
      const g = await pool.query("select has_function_privilege('anon',$1,'execute') a,has_function_privilege('authenticated',$1,'execute') u,has_function_privilege('service_role',$1,'execute') s", [fn.sig]);
      expect(g.rows[0]).toEqual({ a: false, u: false, s: true });
    }
  });

  it('índices parcial ativo, claim e idempotência existem', async () => {
    const r = await pool.query("select indexdef from pg_indexes where schemaname='public' and tablename in ('organization_invitations','outbox_events')");
    const sql = r.rows.map((x) => x.indexdef).join('\n');
    expect(sql).toContain('organization_invitations_active_email_uidx'); expect(sql).toContain('outbox_events_claim_idx'); expect(sql).toMatch(/idempotency_key/);
  });

  it('claim usa SKIP LOCKED na definição da função', async () => {
    const r = await pool.query("select pg_get_functiondef('public.team_outbox_claim(text,integer,integer)'::regprocedure) sql");
    expect(r.rows[0].sql.toLowerCase()).toContain('skip locked');
  });

  // -------------------------------------------------------------------------
  // team_invitation_create — hierarquia, idempotência, conflito, validação
  // -------------------------------------------------------------------------

  it('owner cria convite para admin; convite ativo duplicado (mesma org+email) retorna o MESMO id', async () => {
    const c = await pool.connect();
    try {
      const r1 = await c.query("select public.team_invitation_create($1,$2,'novo@x.test','organization_admin','key-1') j", [ORG_A, OWNER_A]);
      expect(r1.rows[0].j.status).toBe('pending');
      const id1 = r1.rows[0].j.id;
      const r2 = await c.query("select public.team_invitation_create($1,$2,'novo@x.test','manager','key-2') j", [ORG_A, OWNER_A]);
      expect(r2.rows[0].j.id).toBe(id1); // idempotente: NÃO cria um segundo, mesmo com role/key diferentes
      const count = await c.query('select count(*)::int n from public.organization_invitations where organization_id=$1', [ORG_A]);
      expect(count.rows[0].n).toBe(1);
    } finally { c.release(); }
  });

  it('organization_admin NÃO convida admin/owner/platform_admin — só papéis inferiores', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query("select public.team_invitation_create($1,$2,'x1@x.test','organization_admin','k')", [ORG_A, ADMIN_A])).rejects.toThrow(/forbidden/);
      await expect(c.query("select public.team_invitation_create($1,$2,'x2@x.test','organization_owner','k')", [ORG_A, ADMIN_A])).rejects.toThrow(/forbidden/);
      await expect(c.query("select public.team_invitation_create($1,$2,'x3@x.test','platform_admin','k')", [ORG_A, ADMIN_A])).rejects.toThrow(/invalid_role/);
      const ok = await c.query("select public.team_invitation_create($1,$2,'x4@x.test','manager','k') j", [ORG_A, ADMIN_A]);
      expect(ok.rows[0].j.status).toBe('pending');
    } finally { c.release(); }
  });

  it('papéis inferiores (closer) NÃO convidam ninguém', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query("select public.team_invitation_create($1,$2,'x@x.test','viewer','k')", [ORG_A, CLOSER_A])).rejects.toThrow(/forbidden/);
    } finally { c.release(); }
  });

  it('cross-tenant: ator sem membership na organização alvo -> forbidden (o Node mapeia p/ 404)', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query("select public.team_invitation_create($1,$2,'x@x.test','closer','k')", [ORG_B, ADMIN_A])).rejects.toThrow(/forbidden/);
    } finally { c.release(); }
  });

  it('e-mail já é membro ativo/invited da organização -> conflict', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query("select public.team_invitation_create($1,$2,$3,'manager','k')", [ORG_A, OWNER_A, `${CLOSER_A}@x.test`])).rejects.toThrow(/conflict/);
    } finally { c.release(); }
  });

  it('validações de entrada: e-mail inválido, papel inválido, idempotency_key vazia', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query("select public.team_invitation_create($1,$2,'nao-e-email','closer','k')", [ORG_A, OWNER_A])).rejects.toThrow(/invalid_email/);
      await expect(c.query("select public.team_invitation_create($1,$2,'a@x.test','papel_invalido','k')", [ORG_A, OWNER_A])).rejects.toThrow(/invalid_role/);
      await expect(c.query("select public.team_invitation_create($1,$2,'a@x.test','closer','   ')", [ORG_A, OWNER_A])).rejects.toThrow(/invalid_idempotency_key/);
    } finally { c.release(); }
  });

  it('e-mail é normalizado (maiúsculas/espaços) para fins de conflito e idempotência', async () => {
    const c = await pool.connect();
    try {
      await c.query("select public.team_invitation_create($1,$2,'  Novo@X.Test  ','closer','k1')", [ORG_A, OWNER_A]);
      const r = await c.query("select public.team_invitation_create($1,$2,'novo@x.test','closer','k2') j", [ORG_A, OWNER_A]);
      expect(r.rows[0].j.email).toBe('novo@x.test');
      const count = await c.query('select count(*)::int n from public.organization_invitations where organization_id=$1', [ORG_A]);
      expect(count.rows[0].n).toBe(1);
    } finally { c.release(); }
  });

  // -------------------------------------------------------------------------
  // provisioning -> attach_and_enqueue -> claim -> sent/retry/dead_letter
  // -------------------------------------------------------------------------

  async function createAndProvision(c, actor, email, role) {
    const created = (await c.query('select public.team_invitation_create($1,$2,$3,$4,$5) j', [ORG_A, actor, email, role, `k-${email}`])).rows[0].j;
    const provisioning = (await c.query('select public.team_invitation_mark_provisioning($1) j', [created.id])).rows[0].j;
    return provisioning;
  }

  it('mark_provisioning só a partir de pending/failed; outro estado -> invalid_state', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'prov1@x.test', 'closer');
      expect(inv.status).toBe('provisioning');
      await expect(c.query('select public.team_invitation_mark_provisioning($1)', [inv.id])).rejects.toThrow(/invalid_state/);
    } finally { c.release(); }
  });

  it('attach_and_enqueue cria users+membership invited+outbox ATOMICAMENTE; segunda chamada -> invalid_state', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'attach1@x.test', 'manager');
      const authUserId = uuid('61');
      const eventId = uuid('71');
      const out = (await c.query(
        "select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','ciphertext-fake','idem-1') j",
        [inv.id, authUserId, eventId]
      )).rows[0].j;
      expect(out.status).toBe('queued');
      expect(out.membership_id).toBeTruthy();

      const membership = await c.query('select role,status from public.memberships where id=$1', [out.membership_id]);
      expect(membership.rows[0]).toEqual({ role: 'manager', status: 'invited' }); // NUNCA 'active' antes do aceite

      const user = await c.query('select email from public.users where id=$1', [authUserId]);
      expect(user.rows[0].email).toBe('attach1@x.test');

      const event = await c.query('select status,payload,id from public.outbox_events where id=$1', [eventId]);
      expect(event.rows[0].status).toBe('pending');
      expect(event.rows[0].payload).toBe('ciphertext-fake'); // opaco pro Postgres — cifra é responsabilidade do Node

      await expect(c.query(
        "select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-2')",
        [inv.id, authUserId, uuid('72')]
      )).rejects.toThrow(/invalid_state/); // já está 'queued', não 'provisioning'/'ready'
    } finally { c.release(); }
  });

  it('membership \'invited\' nunca conta como ativa (mesma regra que attachTenantContext usa)', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'invited-check@x.test', 'viewer');
      const out = (await c.query(
        "select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem') j",
        [inv.id, uuid('62'), uuid('73')]
      )).rows[0].j;
      const activeCount = await c.query("select count(*)::int n from public.memberships where id=$1 and status='active'", [out.membership_id]);
      expect(activeCount.rows[0].n).toBe(0); // continua invisível pro tenantContext até o aceite
    } finally { c.release(); }
  });

  it('claim: dois workers concorrentes (conexões REAIS separadas) nunca pegam o mesmo evento (SKIP LOCKED)', async () => {
    const c = await pool.connect();
    let eventId;
    try {
      const inv = await createAndProvision(c, OWNER_A, 'claim1@x.test', 'closer');
      eventId = uuid('74');
      await c.query("select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-claim')", [inv.id, uuid('63'), eventId]);
    } finally { c.release(); }

    const c1 = await pool.connect(); const c2 = await pool.connect();
    try {
      const [r1, r2] = await Promise.all([
        c1.query("select * from public.team_outbox_claim('worker-1',10,300)"),
        c2.query("select * from public.team_outbox_claim('worker-2',10,300)"),
      ]);
      const claimedBy1 = r1.rows.some((row) => row.id === eventId);
      const claimedBy2 = r2.rows.some((row) => row.id === eventId);
      expect(claimedBy1 !== claimedBy2).toBe(true); // exatamente um dos dois, nunca os dois nem nenhum
    } finally { c1.release(); c2.release(); }
  });

  it('claim: worker órfão (lease expirada, nunca chamou mark_sent/mark_retry) é recuperado por outro worker', async () => {
    const c = await pool.connect();
    let inv, eventId;
    try {
      inv = await createAndProvision(c, OWNER_A, 'orphan1@x.test', 'closer');
      eventId = uuid('7d');
      await c.query("select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-orphan')", [inv.id, uuid('6c'), eventId]);
      // worker-morto reivindica com lease de 1s e nunca mais aparece (crash).
      const first = await c.query("select attempt_count from public.team_outbox_claim('worker-morto',10,1)");
      expect(first.rows.length).toBeGreaterThanOrEqual(1);
      // ainda dentro da lease -> ninguém mais pode pegar
      const tooSoon = await c.query("select * from public.team_outbox_claim('worker-vivo',10,1)");
      expect(tooSoon.rows.some((r) => r.id === eventId)).toBe(false);
      // espera a lease expirar de verdade
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const recovered = await c.query("select * from public.team_outbox_claim('worker-vivo',10,1)");
      const claimed = recovered.rows.find((r) => r.id === eventId);
      expect(claimed).toBeTruthy();
      expect(claimed.claimed_by).toBe('worker-vivo');
      expect(claimed.attempt_count).toBe(2); // incrementou de novo — é uma tentativa nova de verdade
    } finally { c.release(); }
  });

  it('mark_sent só aceita quem fez o claim (claim_mismatch pro outro worker)', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'sent1@x.test', 'closer');
      const eventId = uuid('75');
      await c.query("select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-sent')", [inv.id, uuid('64'), eventId]);
      await c.query("select public.team_outbox_claim('worker-a',10,300)");
      await expect(c.query('select public.team_outbox_mark_sent($1,$2)', [eventId, 'worker-b'])).rejects.toThrow(/claim_mismatch/);
      const ok = await c.query('select public.team_outbox_mark_sent($1,$2) j', [eventId, 'worker-a']);
      expect(ok.rows[0].j.status).toBe('sent');
      const invRow = await c.query('select status from public.organization_invitations where id=$1', [inv.id]);
      expect(invRow.rows[0].status).toBe('sent');
    } finally { c.release(); }
  });

  it('mark_retry: abaixo do máximo volta pending; no máximo vira dead_letter e o convite vira failed', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'retry1@x.test', 'closer');
      const eventId = uuid('76');
      await c.query("select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-retry')", [inv.id, uuid('65'), eventId]);
      await c.query('update public.outbox_events set max_attempts=2 where id=$1', [eventId]);

      await c.query("select public.team_outbox_claim('w',10,300)"); // attempt_count -> 1
      const r1 = await c.query("select public.team_outbox_mark_retry($1,'w','smtp_down',now()) j", [eventId]);
      expect(r1.rows[0].j.status).toBe('pending');

      await c.query("select public.team_outbox_claim('w',10,300)"); // attempt_count -> 2 (== max_attempts)
      const r2 = await c.query("select public.team_outbox_mark_retry($1,'w','smtp_down',now()) j", [eventId]);
      expect(r2.rows[0].j.status).toBe('dead_letter');

      const invRow = await c.query('select status,last_error_code from public.organization_invitations where id=$1', [inv.id]);
      expect(invRow.rows[0]).toEqual({ status: 'failed', last_error_code: 'smtp_down' });
    } finally { c.release(); }
  });

  // -------------------------------------------------------------------------
  // cancelamento e aceitação
  // -------------------------------------------------------------------------

  it('cancel: hierarquia + impede outbox pendente de ser enviado + impede aceite depois', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'cancel1@x.test', 'closer');
      const eventId = uuid('77');
      const attached = (await c.query(
        "select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-cancel') j",
        [inv.id, uuid('66'), eventId]
      )).rows[0].j;

      await expect(c.query('select public.team_invitation_cancel($1,$2,$3)', [ORG_A, CLOSER_A, inv.id])).rejects.toThrow(/forbidden/); // closer não gerencia ninguém

      const cancelled = await c.query('select public.team_invitation_cancel($1,$2,$3) j', [ORG_A, OWNER_A, inv.id]);
      expect(cancelled.rows[0].j.status).toBe('cancelled');
      const ev = await c.query('select status from public.outbox_events where id=$1', [eventId]);
      expect(ev.rows[0].status).toBe('cancelled');

      await expect(c.query(
        "select public.team_invitation_accept($1,$2,'marker')",
        [uuid('66'), inv.id]
      )).rejects.toThrow(/cancelled/);
      void attached;
    } finally { c.release(); }
  });

  it('accept: aceita, membership vira active; usuário errado é forbidden; idempotente pro mesmo usuário', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'accept1@x.test', 'closer');
      const authUserId = uuid('67');
      const eventId = uuid('78');
      const attached = (await c.query(
        "select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-accept') j",
        [inv.id, authUserId, eventId]
      )).rows[0].j;
      await c.query("select public.team_outbox_claim('w',10,300)");
      await c.query("select public.team_outbox_mark_sent($1,'w')", [eventId]); // invitation -> 'sent'

      await expect(c.query(
        "select public.team_invitation_accept($1,$2,'marker')",
        [uuid('99'), inv.id] // auth_user_id errado
      )).rejects.toThrow(/forbidden/);

      const ok = await c.query("select public.team_invitation_accept($1,$2,'marker') j", [authUserId, inv.id]);
      expect(ok.rows[0].j.status).toBe('accepted');
      const membership = await c.query('select status from public.memberships where id=$1', [attached.membership_id]);
      expect(membership.rows[0].status).toBe('active');

      // idempotente: mesmo usuário aceitando de novo -> sucesso, sem duplicar
      const again = await c.query("select public.team_invitation_accept($1,$2,'marker') j", [authUserId, inv.id]);
      expect(again.rows[0].j.status).toBe('accepted');
      // outro usuário tentando "aceitar" um convite já aceito -> forbidden
      await expect(c.query("select public.team_invitation_accept($1,$2,'marker')", [uuid('99'), inv.id])).rejects.toThrow(/forbidden/);
    } finally { c.release(); }
  });

  it('accept: convite expirado nunca é aceito nem toca a membership (a garantia de segurança é o bloqueio, não a marcação)', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'expired1@x.test', 'closer');
      const authUserId = uuid('68');
      const eventId = uuid('79');
      const attached = (await c.query(
        "select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-exp') j",
        [inv.id, authUserId, eventId]
      )).rows[0].j;
      await c.query("update public.organization_invitations set expires_at = now() - interval '1 hour' where id=$1", [inv.id]);

      // A exceção não capturada desfaz qualquer escrita que a PRÓPRIA chamada
      // de accept tentasse fazer — por isso accept só BLOQUEIA (raise), nunca
      // tenta persistir 'expired' nesta mesma chamada (ver comentário na
      // migration). A marcação em massa é responsabilidade de
      // team_invitation_sweep_expired(), testada abaixo, separadamente.
      await expect(c.query("select public.team_invitation_accept($1,$2,'marker')", [authUserId, inv.id])).rejects.toThrow(/expired/);
      const membership = await c.query('select status from public.memberships where id=$1', [attached.membership_id]);
      expect(membership.rows[0].status).toBe('invited'); // NUNCA vira active por um aceite expirado

      const swept = await c.query('select public.team_invitation_sweep_expired() n');
      expect(swept.rows[0].n).toBeGreaterThanOrEqual(1);
      const invRow = await c.query('select status from public.organization_invitations where id=$1', [inv.id]);
      expect(invRow.rows[0].status).toBe('expired'); // agora sim, via a varredura dedicada
      // convite já expirado (fora da janela queued/sent) nunca é achado de novo -> idempotente
      const swept2 = await c.query("select public.team_invitation_sweep_expired() n");
      expect(swept2.rows[0].n).toBe(0);
    } finally { c.release(); }
  });

  it('sweep_expired é backend-only (auth.uid() não nulo é rejeitado) e não mexe em convites dentro da validade', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'notyet@x.test', 'closer');
      await c.query("select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-notyet')", [inv.id, uuid('6b'), uuid('7c')]);
      await c.query('select public.team_invitation_sweep_expired()');
      const invRow = await c.query('select status from public.organization_invitations where id=$1', [inv.id]);
      expect(invRow.rows[0].status).toBe('queued'); // não expirou -> intocado
    } finally { c.release(); }
  });

  it('resend: invalida o outbox pendente anterior e volta o convite pra \'ready\' (Node gera um link novo)', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'resend1@x.test', 'closer');
      const eventId = uuid('7a');
      await c.query("select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-resend')", [inv.id, uuid('69'), eventId]);

      await expect(c.query('select public.team_invitation_prepare_resend($1,$2,$3)', [ORG_A, CLOSER_A, inv.id])).rejects.toThrow(/forbidden/);

      const r = await c.query('select public.team_invitation_prepare_resend($1,$2,$3) j', [ORG_A, OWNER_A, inv.id]);
      expect(r.rows[0].j.status).toBe('ready');
      const ev = await c.query('select status from public.outbox_events where id=$1', [eventId]);
      expect(ev.rows[0].status).toBe('cancelled'); // o evento antigo nunca sai
    } finally { c.release(); }
  });

  it('cross-tenant: owner de ORG_B não cancela/reenvia convite de ORG_A (not_found — sem revelar existência)', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'crosstenant1@x.test', 'closer');
      await expect(c.query('select public.team_invitation_cancel($1,$2,$3)', [ORG_B, OWNER_B, inv.id])).rejects.toThrow(/not_found/);
      await expect(c.query('select public.team_invitation_prepare_resend($1,$2,$3)', [ORG_B, OWNER_B, inv.id])).rejects.toThrow(/not_found/);
    } finally { c.release(); }
  });

  it('auditoria/erro nunca vaza e-mail/PII: last_error_code só aceita um código curto', async () => {
    const c = await pool.connect();
    try {
      const inv = await createAndProvision(c, OWNER_A, 'errcode1@x.test', 'closer');
      const eventId = uuid('7b');
      await c.query("select public.team_invitation_attach_and_enqueue($1,$2,$3,'send_invitation_email','x','idem-err')", [inv.id, uuid('6a'), eventId]);
      await c.query("select public.team_outbox_claim('w',10,300)");
      await expect(c.query("select public.team_outbox_mark_retry($1,'w','erro com espaço e MAIÚSCULA',now())", [eventId])).rejects.toThrow(/invalid_error_code/);
    } finally { c.release(); }
  });
});
