import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// FASE 2.3 — testes REAIS de RLS + triggers de consistência da expansão do
// tenancy (migration 0010). Sem service_role para o acesso do browser.
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
const NOBODY = '00000000-0000-4000-8000-00000000dead';
const DOC_A = '00000000-0000-4000-8000-0000000000da';
const DOC_B = '00000000-0000-4000-8000-0000000000db';
const LEAD_A1 = '00000000-0000-4000-8000-0000000001a1';
const LEAD_B1 = '00000000-0000-4000-8000-0000000001b1';
const DEAL_A = '00000000-0000-4000-8000-00000000031a';
const DEAL_B = '00000000-0000-4000-8000-00000000031b';
const ATEND_A = '00000000-0000-4000-8000-0000000b0b1a';

let pool;
let ORG_A, ORG_B;

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
async function deniedAs(role, sub, sql, p) {
  await expect(withRole(role, sub, (c) => c.query(sql, p))).rejects.toThrow(
    /permission denied|row-level security|violates|tenant_mismatch/i
  );
}
// como superusuário (dono do banco) — usado para exercitar os TRIGGERS,
// que disparam independentemente de RLS.
async function asSuper(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

d('RLS — tenant expansion (0010) — Supabase local', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 6 });
    const su = await pool.connect();
    try {
      const m = await su.query('select doctor_id, organization_id from public.organization_doctor_map');
      const by = Object.fromEntries(m.rows.map((r) => [r.doctor_id, r.organization_id]));
      ORG_A = by[DOC_A];
      ORG_B = by[DOC_B];
    } finally {
      su.release();
    }
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  // ---------- backfill ----------
  it('backfill preencheu organization_id em todas as tabelas expandidas', async () => {
    await asSuper(async (c) => {
      for (const t of ['conversations', 'atendimentos', 'transactions', 'knowledge_base', 'knowledge_chunks', 'ia_agentes_bdr']) {
        const n = (await c.query(`select count(*)::int n from public.${t} where organization_id is null`)).rows[0].n;
        expect({ t, n }).toEqual({ t, n: 0 });
      }
      // e cada linha bate com a organização do seu parent
      const conv = await c.query(
        'select count(*)::int n from public.conversations c join public.leads l on l.id = c.lead_id where c.organization_id <> l.organization_id'
      );
      expect(conv.rows[0].n).toBe(0);
      const tx = await c.query(
        'select count(*)::int n from public.transactions t join public.deals dd on dd.id = t.deal_id join public.leads l on l.id = dd.lead_id where t.organization_id <> l.organization_id'
      );
      expect(tx.rows[0].n).toBe(0);
    });
  });

  // ---------- deny-all para o browser ----------
  it('anon/authenticated NÃO leem as tabelas backend-only (nem a coluna organization_id)', async () => {
    for (const t of ['conversations', 'transactions', 'knowledge_base', 'knowledge_chunks', 'ia_agentes_bdr']) {
      await deniedAs('anon', null, `select organization_id from public.${t}`);
      await deniedAs('authenticated', A_OWNER, `select organization_id from public.${t}`);
    }
  });

  // ---------- atendimentos: policy org OR'd (equivalente à doctor) ----------
  it('atendimentos: owner A vê só a Org A; owner B só a Org B; NOBODY nada', async () => {
    const aRows = await asUser(A_OWNER, (c) => c.query('select organization_id from public.atendimentos'));
    expect(aRows.rows.every((r) => r.organization_id === ORG_A)).toBe(true);
    expect(aRows.rows.length).toBeGreaterThan(0);
    const bRows = await asUser(B_OWNER, (c) => c.query('select organization_id from public.atendimentos'));
    expect(bRows.rows.every((r) => r.organization_id === ORG_B)).toBe(true);
    const none = await asUser(NOBODY, (c) => c.query('select id from public.atendimentos'));
    expect(none.rows).toHaveLength(0);
  });

  it('atendimentos: id conhecido da Org A é invisível para o owner B', async () => {
    const r = await asUser(B_OWNER, (c) => c.query('select id from public.atendimentos where id = $1', [ATEND_A]));
    expect(r.rows).toHaveLength(0);
  });

  // ---------- triggers de consistência ----------
  it('trigger: conversation NÃO pode receber organization_id != organização do lead (INSERT)', async () => {
    await asSuper(async (c) => {
      await expect(
        c.query(
          "insert into public.conversations (lead_id, canal, direcao, conteudo, origem, organization_id) values ($1,'whatsapp','recebida','x','automatico',$2)",
          [LEAD_A1, ORG_B]
        )
      ).rejects.toThrow(/tenant_mismatch/i);
    });
  });

  it('trigger: conversation com organization_id NULL é preenchido a partir do lead', async () => {
    await asSuper(async (c) => {
      const r = await c.query(
        "insert into public.conversations (lead_id, canal, direcao, conteudo, origem) values ($1,'whatsapp','recebida','y','automatico') returning organization_id",
        [LEAD_A1]
      );
      expect(r.rows[0].organization_id).toBe(ORG_A);
    });
  });

  it('trigger: UPDATE tentando mover a conversation para outra organização falha', async () => {
    await asSuper(async (c) => {
      await expect(
        c.query('update public.conversations set organization_id = $1 where lead_id = $2', [ORG_B, LEAD_A1])
      ).rejects.toThrow(/tenant_mismatch/i);
    });
  });

  it('trigger: transaction NÃO pode receber organization_id != organização do deal/lead', async () => {
    await asSuper(async (c) => {
      await expect(
        c.query(
          "insert into public.transactions (deal_id, gateway, gateway_transaction_id, valor, status, organization_id) values ($1,'pagarme','tx-x',1,'pago',$2)",
          [DEAL_A, ORG_B]
        )
      ).rejects.toThrow(/tenant_mismatch/i);
    });
  });

  it('trigger: transaction sem deal_id -> organization_id fica NULL (estado legítimo)', async () => {
    await asSuper(async (c) => {
      const r = await c.query(
        "insert into public.transactions (gateway, gateway_transaction_id, valor, status) values ('pagarme','tx-nodeal',1,'pago') returning organization_id"
      );
      expect(r.rows[0].organization_id).toBeNull();
    });
  });

  it('propagação: mudar leads.organization_id arrasta conversations/atendimentos/transactions', async () => {
    await asSuper(async (c) => {
      // move o lead A1 para a Org B e confirma que os filhos acompanham
      await c.query('update public.leads set organization_id = $1 where id = $2', [ORG_B, LEAD_A1]);
      const conv = await c.query('select distinct organization_id from public.conversations where lead_id = $1', [LEAD_A1]);
      expect(conv.rows).toEqual([{ organization_id: ORG_B }]);
      const at = await c.query('select distinct organization_id from public.atendimentos where lead_id = $1', [LEAD_A1]);
      expect(at.rows.every((r) => r.organization_id === ORG_B)).toBe(true);
      const tx = await c.query(
        'select t.organization_id from public.transactions t join public.deals dd on dd.id = t.deal_id where dd.lead_id = $1',
        [LEAD_A1]
      );
      expect(tx.rows.every((r) => r.organization_id === ORG_B)).toBe(true);
    });
  });

  // ---------- funções endurecidas ----------
  it('0010: helpers com search_path fixo e sem EXECUTE para anon', async () => {
    await asSuper(async (c) => {
      const fns = await c.query(
        "select proname, proconfig from pg_proc where pronamespace='public'::regnamespace and proname in ('org_of_lead','org_of_deal','enforce_org_from_lead','enforce_org_from_deal','propagate_lead_org','backfill_tenant_expansion')"
      );
      expect(fns.rows.length).toBe(6);
      for (const f of fns.rows) {
        expect((f.proconfig || []).some((x) => x.startsWith('search_path='))).toBe(true);
      }
      const anonGrants = await c.query(
        "select routine_name from information_schema.role_routine_grants where routine_schema='public' and grantee='anon' and routine_name in ('org_of_lead','org_of_deal','enforce_org_from_lead','enforce_org_from_deal','propagate_lead_org','backfill_tenant_expansion')"
      );
      expect(anonGrants.rows).toHaveLength(0);
    });
  });

  it('nenhuma policy pública USING(true) nas tabelas expandidas', async () => {
    await asSuper(async (c) => {
      const r = await c.query(
        "select tablename, policyname, qual from pg_policies where schemaname='public' and tablename in ('conversations','transactions','atendimentos','knowledge_base','knowledge_chunks','ia_agentes_bdr') and qual = 'true'"
      );
      expect(r.rows).toHaveLength(0);
    });
  });
});
