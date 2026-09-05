import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// FASE 2.8 — job_queue + usage_ledger/limits/reservations/cost_alerts (0014).
// Rodar: SUPABASE_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npx vitest run test/rls/persistent-jobs-and-quotas.rls.test.js
//
// As RPCs desta fase são todas backend-only (service_role). Aqui os testes
// chamam via `pg` como superuser — o que importa é a lógica de negócio
// (idempotência, claim, lease, quota) e a superfície (RLS, grants).

const DB_URL = process.env.SUPABASE_TEST_DB_URL;
let pg; try { pg = (await import('pg')).default; } catch { pg = null; }
const d = DB_URL && pg ? describe : describe.skip;

// prefixo a000 (não colide com 8000 team-memberships nem 9000 team-invitations)
const uuid = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const ORG_A = uuid('a1');
const ORG_B = uuid('b1');
const UNIT_A = uuid('a2');
const OWNER_A = uuid('11');
const MANAGER_A = uuid('12');
const CLOSER_A = uuid('13');
const OWNER_B = uuid('14');
const DOC_A = uuid('d1');
const DOC_B = uuid('d2');
const CAMP_A = uuid('c1');
const CAMP_B = uuid('c2');
const LEAD_A1 = uuid('e1');
const LEAD_A2 = uuid('e2');
const LEAD_B1 = uuid('f1');

let pool;

async function reset(c) {
  await c.query('begin');
  await c.query('delete from public.campanha_envios where campanha_id in ($1,$2)', [CAMP_A, CAMP_B]);
  await c.query('delete from public.job_queue where organization_id in ($1,$2) or organization_id is null', [ORG_A, ORG_B]);
  await c.query('delete from public.usage_ledger where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await c.query('delete from public.usage_reservations where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await c.query('delete from public.usage_limits where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await c.query('delete from public.cost_alerts where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await c.query('delete from public.campanhas where id in ($1,$2)', [CAMP_A, CAMP_B]);
  await c.query('delete from public.leads where id = any($1)', [[LEAD_A1, LEAD_A2, LEAD_B1]]);
  await c.query('delete from public.memberships where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await c.query('delete from public.organization_doctor_map where organization_id in ($1,$2)', [ORG_A, ORG_B]);
  await c.query('delete from public.units where id = $1', [UNIT_A]);
  await c.query('delete from public.doctors where id = any($1)', [[DOC_A, DOC_B]]);
  await c.query('delete from public.organizations where id in ($1,$2)', [ORG_A, ORG_B]);
  await c.query('delete from public.users where id = any($1)', [[OWNER_A, MANAGER_A, CLOSER_A, OWNER_B]]);
  for (const [id, nome] of [[OWNER_A, 'Owner A'], [MANAGER_A, 'Manager A'], [CLOSER_A, 'Closer A'], [OWNER_B, 'Owner B']]) {
    await c.query("insert into public.users (id, nome, email, role, ativo) values ($1,$2,$3,'closer',true) on conflict (id) do nothing", [id, nome, `${id}@x.test`]);
  }
  await c.query("insert into public.organizations (id, name, slug, status) values ($1,'Org A','org-a-jobs','active'), ($2,'Org B','org-b-jobs','active')", [ORG_A, ORG_B]);
  await c.query("insert into public.units (id, organization_id, name, status) values ($1,$2,'Unidade A','active')", [UNIT_A, ORG_A]);
  await c.query('insert into public.doctors (id, owner_user_id) values ($1,$2), ($3,$4)', [DOC_A, OWNER_A, DOC_B, OWNER_B]);
  await c.query('insert into public.organization_doctor_map (organization_id, doctor_id) values ($1,$2), ($3,$4)', [ORG_A, DOC_A, ORG_B, DOC_B]);
  await c.query("insert into public.campanhas (id, doctor_id, organization_id, nome, mensagem, status) values ($1,$2,$3,'C A','oi','processando'), ($4,$5,$6,'C B','oi','processando')", [CAMP_A, DOC_A, ORG_A, CAMP_B, DOC_B, ORG_B]);
  await c.query("insert into public.leads (id, doctor_id, telefone, status_atual) values ($1,$2,'551101','lead'), ($3,$4,'551102','lead'), ($5,$6,'559901','lead')", [LEAD_A1, DOC_A, LEAD_A2, DOC_A, LEAD_B1, DOC_B]);
  await c.query(
    "insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'organization_owner','active'), ($1,$3,'manager','active'), ($1,$4,'closer','active')",
    [ORG_A, OWNER_A, MANAGER_A, CLOSER_A]
  );
  await c.query("insert into public.memberships (organization_id, user_id, role, status) values ($1,$2,'organization_owner','active')", [ORG_B, OWNER_B]);
  await c.query('commit');
}

d('RLS/RPC — persistent jobs & usage quotas 0014 — Supabase local', () => {
  beforeAll(() => { pool = new pg.Pool({ connectionString: DB_URL, max: 6 }); });
  afterAll(async () => {
    if (!pool) return;
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('delete from public.campanha_envios where campanha_id in ($1,$2)', [CAMP_A, CAMP_B]);
      await c.query('delete from public.job_queue where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.usage_ledger where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.usage_reservations where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.usage_limits where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.cost_alerts where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.campanhas where id in ($1,$2)', [CAMP_A, CAMP_B]);
      await c.query('delete from public.leads where id = any($1)', [[LEAD_A1, LEAD_A2, LEAD_B1]]);
      await c.query('delete from public.memberships where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.organization_doctor_map where organization_id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.units where id = $1', [UNIT_A]);
      await c.query('delete from public.doctors where id = any($1)', [[DOC_A, DOC_B]]);
      await c.query('delete from public.organizations where id in ($1,$2)', [ORG_A, ORG_B]);
      await c.query('delete from public.users where id = any($1)', [[OWNER_A, MANAGER_A, CLOSER_A, OWNER_B]]);
      await c.query('commit');
    } catch { await c.query('rollback').catch(() => {}); }
    finally { c.release(); }
    await pool.end();
  });
  beforeEach(async () => { const c = await pool.connect(); try { await reset(c); } finally { c.release(); } });

  // ---- superfície: RLS / grants ----

  it('tabelas existem, RLS ligada, zero policy pública, sem privilégio pra anon/authenticated', async () => {
    const tables = ['job_queue', 'usage_ledger', 'usage_limits', 'cost_alerts', 'usage_reservations'];
    const rls = await pool.query(`select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname = any($1) order by relname`, [tables]);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
    expect(rls.rows.length).toBe(5);
    const pol = await pool.query("select count(*)::int n from pg_policies where schemaname='public' and tablename = any($1)", [tables]);
    expect(pol.rows[0].n).toBe(0);
    for (const t of tables) {
      const pub = await pool.query("select count(*)::int n from information_schema.role_table_grants where table_schema='public' and table_name=$1 and grantee='PUBLIC'", [t]);
      expect(pub.rows[0].n, `PUBLIC ${t}`).toBe(0);
      for (const role of ['anon', 'authenticated']) {
        const r = await pool.query('select has_table_privilege($1,$2,$3) ok', [role, `public.${t}`, 'select,insert,update,delete']);
        expect(r.rows[0].ok, `${role} ${t}`).toBe(false);
      }
    }
  });

  it('todas as RPCs 0014 são security definer/search_path vazio e só service_role executa', async () => {
    const r = await pool.query("select p.oid::regprocedure::text sig,p.prosecdef,coalesce(array_to_string(p.proconfig,','),'') cfg from pg_proc p where p.pronamespace='public'::regnamespace and (p.proname like 'job\\_%' or p.proname like 'usage\\_%')");
    expect(r.rows.length).toBeGreaterThanOrEqual(10);
    for (const fn of r.rows) {
      expect(fn.prosecdef, fn.sig).toBe(true);
      expect(fn.cfg, fn.sig).toContain('search_path=');
      const g = await pool.query("select has_function_privilege('anon',$1,'execute') a,has_function_privilege('authenticated',$1,'execute') u,has_function_privilege('service_role',$1,'execute') s", [fn.sig]);
      expect(g.rows[0], fn.sig).toEqual({ a: false, u: false, s: true });
    }
  });

  // ---- job_queue: enqueue / claim / lease / heartbeat / retry / cancel ----

  it('enqueue idempotente por (organization_id, job_type, idempotency_key) — segunda chamada devolve o MESMO job', async () => {
    const c = await pool.connect();
    try {
      const a = await c.query("select public.job_enqueue($1,$2,null,'campaign.send_message','payload-1','k-1',0,now(),5) j", [uuid('90'), ORG_A]);
      const b = await c.query("select public.job_enqueue($1,$2,null,'campaign.send_message','payload-2','k-1',0,now(),5) j", [uuid('91'), ORG_A]);
      expect(b.rows[0].j.id).toBe(a.rows[0].j.id);
      expect(b.rows[0].j.payload).toBe('payload-1'); // não sobrescreve
      const cnt = await c.query("select count(*)::int n from public.job_queue where organization_id=$1", [ORG_A]);
      expect(cnt.rows[0].n).toBe(1);
      // mesma idempotency_key em OUTRA org -> job separado
      const other = await c.query("select public.job_enqueue($1,$2,null,'campaign.send_message','p','k-1',0,now(),5) j", [uuid('92'), ORG_B]);
      expect(other.rows[0].j.id).not.toBe(a.rows[0].j.id);
    } finally { c.release(); }
  });

  it('enqueue: organização ausente para tipo NÃO-global é rejeitada; tipo global fora da allowlist é rejeitado', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query("select public.job_enqueue($1,null,null,'campaign.send_message','p','k',0,now(),5)", [uuid('93')])).rejects.toThrow(/organization_required/);
      await expect(c.query("select public.job_enqueue($1,null,null,'evil.global_task','p','k',0,now(),5)", [uuid('94')])).rejects.toThrow(/(organization_required|violates check constraint)/);
      const ok = await c.query("select public.job_enqueue($1,null,null,'system.maintenance','p','k-sys',0,now(),5) j", [uuid('95')]);
      expect(ok.rows[0].j.job_type).toBe('system.maintenance');
    } finally { c.release(); }
  });

  it('claim: dois workers REAIS concorrentes nunca pegam o mesmo job (SKIP LOCKED)', async () => {
    const setup = await pool.connect();
    let jobId;
    try {
      jobId = (await setup.query("select public.job_enqueue($1,$2,null,'campaign.send_message','p','k-claim',0,now(),5) j", [uuid('96'), ORG_A])).rows[0].j.id;
    } finally { setup.release(); }
    const c1 = await pool.connect(); const c2 = await pool.connect();
    try {
      const [r1, r2] = await Promise.all([
        c1.query("select * from public.job_claim('w1',10,300,null)"),
        c2.query("select * from public.job_claim('w2',10,300,null)"),
      ]);
      const by1 = r1.rows.some((x) => x.id === jobId);
      const by2 = r2.rows.some((x) => x.id === jobId);
      expect(by1 !== by2).toBe(true);
    } finally { c1.release(); c2.release(); }
  });

  it('lease expirada é recuperável por outro worker; heartbeat renova e impede roubo', async () => {
    const c = await pool.connect();
    try {
      const jobId = (await c.query("select public.job_enqueue($1,$2,null,'campaign.send_message','p','k-lease',0,now(),5) j", [uuid('97'), ORG_A])).rows[0].j.id;
      await c.query("select public.job_claim('w-morto',10,1,null)"); // lease de 1s
      // dentro da lease -> ninguém mais pega
      const tooSoon = await c.query("select * from public.job_claim('w-vivo',10,1,null)");
      expect(tooSoon.rows.some((x) => x.id === jobId)).toBe(false);
      await new Promise((r) => setTimeout(r, 1200));
      // heartbeat do worker ERRADO -> claim_mismatch
      await expect(c.query("select public.job_heartbeat($1,'w-outro',60)", [jobId])).rejects.toThrow(/claim_mismatch/);
      // agora w-vivo recupera
      const recovered = await c.query("select * from public.job_claim('w-vivo',10,60,null)");
      const j = recovered.rows.find((x) => x.id === jobId);
      expect(j?.lease_owner).toBe('w-vivo');
      expect(j.attempts).toBe(2);
      // heartbeat do w-vivo (dono atual) renova
      const hb = await c.query("select public.job_heartbeat($1,'w-vivo',120) j", [jobId]);
      expect(new Date(hb.rows[0].j.lease_expires_at).getTime()).toBeGreaterThan(Date.now() + 60_000);
    } finally { c.release(); }
  });

  it('retry: abaixo do máximo volta a retry; no máximo vira dead_letter', async () => {
    const c = await pool.connect();
    try {
      const jobId = (await c.query("select public.job_enqueue($1,$2,null,'campaign.send_message','p','k-retry',0,now(),2) j", [uuid('98'), ORG_A])).rows[0].j.id;
      await c.query("select public.job_claim('w',10,300,null)"); // attempts -> 1
      const r1 = await c.query("select public.job_retry($1,'w','boom',now()) j", [jobId]);
      expect(r1.rows[0].j.status).toBe('retry');
      await c.query("select public.job_claim('w',10,300,null)"); // attempts -> 2 (== max)
      const r2 = await c.query("select public.job_retry($1,'w','boom',now()) j", [jobId]);
      expect(r2.rows[0].j.status).toBe('dead_letter');
      expect(r2.rows[0].j.last_error_code).toBe('boom');
    } finally { c.release(); }
  });

  it('complete/retry/heartbeat só aceitam o worker que fez o claim', async () => {
    const c = await pool.connect();
    try {
      const jobId = (await c.query("select public.job_enqueue($1,$2,null,'campaign.send_message','p','k-owner',0,now(),5) j", [uuid('99'), ORG_A])).rows[0].j.id;
      await c.query("select public.job_claim('w-a',10,300,null)");
      await expect(c.query("select public.job_complete($1,'w-b')", [jobId])).rejects.toThrow(/claim_mismatch/);
      await expect(c.query("select public.job_retry($1,'w-b','x',now())", [jobId])).rejects.toThrow(/claim_mismatch/);
      const ok = await c.query("select public.job_complete($1,'w-a') j", [jobId]);
      expect(ok.rows[0].j.status).toBe('completed');
    } finally { c.release(); }
  });

  it('cancel: só organization_owner/organization_admin (mesmo gate de gestão de equipe da FASE 2.6 — o papel "manager" e closers NÃO cancelam); cross-tenant -> not_found', async () => {
    const c = await pool.connect();
    try {
      const jobId = (await c.query("select public.job_enqueue($1,$2,null,'campaign.send_message','p','k-cancel',0,now(),5) j", [uuid('a0'), ORG_A])).rows[0].j.id;
      await expect(c.query('select public.job_cancel($1,$2,$3)', [ORG_A, CLOSER_A, jobId])).rejects.toThrow(/forbidden/);
      await expect(c.query('select public.job_cancel($1,$2,$3)', [ORG_A, MANAGER_A, jobId])).rejects.toThrow(/forbidden/); // papel "manager" != gestor de equipe
      await expect(c.query('select public.job_cancel($1,$2,$3)', [ORG_B, OWNER_B, jobId])).rejects.toThrow(/not_found/);
      const ok = await c.query('select public.job_cancel($1,$2,$3) j', [ORG_A, OWNER_A, jobId]);
      expect(ok.rows[0].j.status).toBe('cancelled');
    } finally { c.release(); }
  });

  it('payload: Postgres guarda o texto opaco (a cifra é do Node); payload > 64KB é rejeitado (poison job por tamanho)', async () => {
    const c = await pool.connect();
    try {
      const j = (await c.query("select public.job_enqueue($1,$2,null,'campaign.send_message','e1.v1.aaa.bbb.ccc','k-enc',0,now(),5) j", [uuid('a1'), ORG_A])).rows[0].j;
      expect(j.payload).toBe('e1.v1.aaa.bbb.ccc');
      const huge = 'x'.repeat(70000);
      await expect(c.query("select public.job_enqueue($1,$2,null,'campaign.send_message',$3,'k-huge',0,now(),5)", [uuid('a2'), ORG_A, huge])).rejects.toThrow(/violates check constraint|value too long/);
    } finally { c.release(); }
  });

  // ---- quotas: reserve / settle / release / limites / alertas ----

  it('hard limit + action=block: reserva concorrente NUNCA ultrapassa o teto', async () => {
    const c = await pool.connect();
    try {
      await c.query("insert into public.usage_limits (organization_id,category,period,hard_limit,action) values ($1,'whatsapp_messages','daily',1,'block')", [ORG_A]);
    } finally { c.release(); }
    const c1 = await pool.connect(); const c2 = await pool.connect();
    try {
      const [r1, r2] = await Promise.all([
        c1.query("select public.usage_reserve($1,'whatsapp_messages',1,'r-conc-1') j", [ORG_A]),
        c2.query("select public.usage_reserve($1,'whatsapp_messages',1,'r-conc-2') j", [ORG_A]),
      ]);
      const allowed = [r1.rows[0].j.allowed, r2.rows[0].j.allowed];
      expect(allowed.filter(Boolean).length).toBe(1); // exatamente uma passou
    } finally { c1.release(); c2.release(); }
  });

  it('reserva idempotente: mesma idempotency_key devolve a mesma reserva, não conta duas vezes', async () => {
    const c = await pool.connect();
    try {
      await c.query("insert into public.usage_limits (organization_id,category,period,hard_limit,action) values ($1,'emails','daily',1,'block')", [ORG_A]);
      const a = await c.query("select public.usage_reserve($1,'emails',1,'r-idem') j", [ORG_A]);
      const b = await c.query("select public.usage_reserve($1,'emails',1,'r-idem') j", [ORG_A]);
      expect(b.rows[0].j.reservation_id).toBe(a.rows[0].j.reservation_id);
      expect(b.rows[0].j.allowed).toBe(true);
    } finally { c.release(); }
  });

  it('soft limit + action=warn: gera exatamente UM cost_alerts (dedup), não bloqueia', async () => {
    const c = await pool.connect();
    try {
      await c.query("insert into public.usage_limits (organization_id,category,period,soft_limit,action) values ($1,'ai_requests','daily',1,'warn')", [ORG_A]);
      const a = await c.query("select public.usage_reserve($1,'ai_requests',2,'r-soft-1') j", [ORG_A]);
      const b = await c.query("select public.usage_reserve($1,'ai_requests',2,'r-soft-2') j", [ORG_A]);
      expect(a.rows[0].j.allowed).toBe(true);
      expect(b.rows[0].j.allowed).toBe(true); // warn nunca bloqueia
      const alerts = await c.query("select count(*)::int n from public.cost_alerts where organization_id=$1 and category='ai_requests'", [ORG_A]);
      expect(alerts.rows[0].n).toBe(1);
    } finally { c.release(); }
  });

  it('settle grava no ledger (idempotente); release não grava custo; ledger nunca duplica', async () => {
    const c = await pool.connect();
    try {
      const res = await c.query("select public.usage_reserve($1,'whatsapp_messages',1,'r-set') j", [ORG_A]);
      const rid = res.rows[0].j.reservation_id;
      const s1 = await c.query("select public.usage_settle($1,1,0.05,'led-1') j", [rid]);
      const s2 = await c.query("select public.usage_settle($1,1,0.05,'led-1') j", [rid]); // idempotente
      expect(s2.rows[0].j.id).toBe(s1.rows[0].j.id);
      const cnt = await c.query("select count(*)::int n from public.usage_ledger where idempotency_key='led-1'");
      expect(cnt.rows[0].n).toBe(1);
      // release de uma reserva JÁ settled -> invalid_state (não dá pra descobrar)
      await expect(c.query('select public.usage_release($1)', [rid])).rejects.toThrow(/invalid_state/);

      const res2 = await c.query("select public.usage_reserve($1,'emails',1,'r-rel') j", [ORG_A]);
      const rid2 = res2.rows[0].j.reservation_id;
      await c.query('select public.usage_release($1)', [rid2]);
      await c.query('select public.usage_release($1)', [rid2]); // idempotente
      const ledCnt = await c.query("select count(*)::int n from public.usage_ledger where organization_id=$1 and category='emails'", [ORG_A]);
      expect(ledCnt.rows[0].n).toBe(0); // release nunca vira custo
    } finally { c.release(); }
  });

  it('reserva órfã (reserved, velha) é liberada pelo sweep — nunca trava a quota da própria org pra sempre', async () => {
    const c = await pool.connect();
    try {
      const res = await c.query("select public.usage_reserve($1,'whatsapp_messages',1,'r-orphan') j", [ORG_A]);
      const rid = res.rows[0].j.reservation_id;
      await c.query("update public.usage_reservations set created_at = now() - interval '2 days' where id=$1", [rid]);
      const swept = await c.query('select public.usage_reservations_sweep_stale(86400) n');
      expect(swept.rows[0].n).toBeGreaterThanOrEqual(1);
      const row = await c.query('select status from public.usage_reservations where id=$1', [rid]);
      expect(row.rows[0].status).toBe('released');
      // reserva recente NÃO é tocada
      const fresh = await c.query("select public.usage_reserve($1,'whatsapp_messages',1,'r-fresh') j", [ORG_A]);
      await c.query('select public.usage_reservations_sweep_stale(86400)');
      const freshRow = await c.query('select status from public.usage_reservations where id=$1', [fresh.rows[0].j.reservation_id]);
      expect(freshRow.rows[0].status).toBe('reserved');
    } finally { c.release(); }
  });

  it('custo negativo e quantidade <= 0 são rejeitados (sem overflow/valor absurdo no ledger)', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query("select public.usage_reserve($1,'emails',0,'r-zero')", [ORG_A])).rejects.toThrow(/invalid_argument/);
      await expect(c.query("select public.usage_reserve($1,'emails',-5,'r-neg')", [ORG_A])).rejects.toThrow(/invalid_argument/);
      const res = await c.query("select public.usage_reserve($1,'emails',1,'r-cost') j", [ORG_A]);
      await expect(c.query("select public.usage_settle($1,1,-1,'led-neg')", [res.rows[0].j.reservation_id])).rejects.toThrow(/(violates check constraint|invalid)/);
    } finally { c.release(); }
  });

  it('usage_aggregate soma só a janela pedida e nunca vaza dado de outra org', async () => {
    const c = await pool.connect();
    try {
      const r1 = await c.query("select public.usage_reserve($1,'whatsapp_messages',3,'agg-1') j", [ORG_A]);
      await c.query("select public.usage_settle($1,3,0.30,'agg-led-1')", [r1.rows[0].j.reservation_id]);
      const r2 = await c.query("select public.usage_reserve($1,'whatsapp_messages',5,'agg-2') j", [ORG_B]);
      await c.query("select public.usage_settle($1,5,0.50,'agg-led-2')", [r2.rows[0].j.reservation_id]);
      const agg = await c.query("select * from public.usage_aggregate($1, now() - interval '1 hour', now() + interval '1 hour')", [ORG_A]);
      const wa = agg.rows.find((x) => x.category === 'whatsapp_messages');
      expect(Number(wa.quantity)).toBe(3); // só ORG_A
    } finally { c.release(); }
  });

  // -------------------------------------------------------------------------
  // campaign_recipient_enqueue — atomicidade job <-> campanha_envios
  // -------------------------------------------------------------------------

  it('job e campanha_envios nascem ATOMICAMENTE e vinculados (job_id preenchido)', async () => {
    const c = await pool.connect();
    try {
      const r = await c.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'e1.v1.aa.bb.cc') j", [uuid('b0'), ORG_A, CAMP_A, LEAD_A1]);
      const out = r.rows[0].j;
      expect(out.created).toBe(true);
      const envio = await c.query('select id,status,job_id from public.campanha_envios where campanha_id=$1 and lead_id=$2', [CAMP_A, LEAD_A1]);
      const job = await c.query('select id,payload,job_type from public.job_queue where id=$1', [out.job_id]);
      expect(envio.rows[0].status).toBe('enviando');
      expect(envio.rows[0].job_id).toBe(job.rows[0].id); // vínculo lógico
      expect(job.rows[0].job_type).toBe('campaign.send_message');
    } finally { c.release(); }
  });

  it('falha ANTES do commit (payload vazio) -> zero linha nas DUAS tabelas', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'   ')", [uuid('b1'), ORG_A, CAMP_A, LEAD_A1])).rejects.toThrow(/invalid_argument/);
      const e = await c.query('select count(*)::int n from public.campanha_envios where campanha_id=$1 and lead_id=$2', [CAMP_A, LEAD_A1]);
      const j = await c.query("select count(*)::int n from public.job_queue where organization_id=$1 and idempotency_key=$2", [ORG_A, `${CAMP_A}:${LEAD_A1}`]);
      expect(e.rows[0].n).toBe(0);
      expect(j.rows[0].n).toBe(0);
    } finally { c.release(); }
  });

  it('dois dispatches concorrentes (conexões REAIS) -> exatamente 1 envio e 1 job', async () => {
    const c1 = await pool.connect(); const c2 = await pool.connect();
    try {
      await Promise.allSettled([
        c1.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'e1.v1.a.b.c') j", [uuid('b2'), ORG_A, CAMP_A, LEAD_A1]),
        c2.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'e1.v1.d.e.f') j", [uuid('b3'), ORG_A, CAMP_A, LEAD_A1]),
      ]);
    } finally { c1.release(); c2.release(); }
    const c = await pool.connect();
    try {
      const e = await c.query('select count(*)::int n from public.campanha_envios where campanha_id=$1 and lead_id=$2', [CAMP_A, LEAD_A1]);
      const j = await c.query("select count(*)::int n from public.job_queue where organization_id=$1 and idempotency_key=$2", [ORG_A, `${CAMP_A}:${LEAD_A1}`]);
      expect(e.rows[0].n).toBe(1);
      expect(j.rows[0].n).toBe(1);
    } finally { c.release(); }
  });

  it('retry NÃO rebaixa estado terminal: envio já "enviado" -> devolve terminal, não recria job nem volta pra "enviando"', async () => {
    const c = await pool.connect();
    try {
      // 1ª chamada cria o par
      const r1 = await c.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'e1.v1.a.b.c') j", [uuid('b4'), ORG_A, CAMP_A, LEAD_A1]);
      const jobId = r1.rows[0].j.job_id;
      // simula o send concluído
      await c.query("update public.campanha_envios set status='enviado' where campanha_id=$1 and lead_id=$2", [CAMP_A, LEAD_A1]);
      // retry do dispatch (mesmo lead)
      const r2 = await c.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'e1.v1.x.y.z') j", [uuid('b5'), ORG_A, CAMP_A, LEAD_A1]);
      expect(r2.rows[0].j.terminal).toBe(true);
      expect(r2.rows[0].j.envio_status).toBe('enviado');
      const envio = await c.query('select status from public.campanha_envios where campanha_id=$1 and lead_id=$2', [CAMP_A, LEAD_A1]);
      expect(envio.rows[0].status).toBe('enviado'); // NÃO rebaixado
      const jobs = await c.query("select count(*)::int n from public.job_queue where organization_id=$1 and idempotency_key=$2", [ORG_A, `${CAMP_A}:${LEAD_A1}`]);
      expect(jobs.rows[0].n).toBe(1); // não recriou
      void jobId;
    } finally { c.release(); }
  });

  it('retry NÃO rebaixa "falhou" pra "enviando"', async () => {
    const c = await pool.connect();
    try {
      await c.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'e1.v1.a.b.c')", [uuid('b6'), ORG_A, CAMP_A, LEAD_A1]);
      await c.query("update public.campanha_envios set status='falhou' where campanha_id=$1 and lead_id=$2", [CAMP_A, LEAD_A1]);
      const r = await c.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'e1.v1.x.y.z') j", [uuid('b7'), ORG_A, CAMP_A, LEAD_A1]);
      expect(r.rows[0].j.terminal).toBe(true);
      const envio = await c.query('select status from public.campanha_envios where campanha_id=$1 and lead_id=$2', [CAMP_A, LEAD_A1]);
      expect(envio.rows[0].status).toBe('falhou');
    } finally { c.release(); }
  });

  it('cross-tenant: lead de outra organização -> forbidden; campanha de outra org -> forbidden', async () => {
    const c = await pool.connect();
    try {
      // ORG_A + campanha A + lead de DOC_B (org B)
      await expect(c.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'e1.v1.a.b.c')", [uuid('b8'), ORG_A, CAMP_A, LEAD_B1])).rejects.toThrow(/forbidden/);
      // ORG_A informado, mas a campanha B é de ORG_B
      await expect(c.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'e1.v1.a.b.c')", [uuid('b9'), ORG_A, CAMP_B, LEAD_B1])).rejects.toThrow(/forbidden/);
      // nada foi criado
      const j = await c.query("select count(*)::int n from public.job_queue where organization_id=$1", [ORG_A]);
      expect(j.rows[0].n).toBe(0);
    } finally { c.release(); }
  });

  it('idempotency_key NÃO é parâmetro — é sempre derivada (campanha:lead) dentro da RPC', async () => {
    const c = await pool.connect();
    try {
      const r = await c.query("select public.campaign_recipient_enqueue($1,$2,$3,$4,'e1.v1.a.b.c') j", [uuid('ba'), ORG_A, CAMP_A, LEAD_A2]);
      const job = await c.query('select idempotency_key from public.job_queue where id=$1', [r.rows[0].j.job_id]);
      expect(job.rows[0].idempotency_key).toBe(`${CAMP_A}:${LEAD_A2}`);
      // a assinatura da função tem 5 params e nenhum é idempotency_key:
      const sig = await c.query("select pg_get_function_arguments('public.campaign_recipient_enqueue(uuid,uuid,uuid,uuid,text)'::regprocedure) a");
      expect(sig.rows[0].a).not.toMatch(/idempotency/i);
    } finally { c.release(); }
  });
});
