// FASE 2.9 — inventário PRÉ-cutover multitenant. SOMENTE LEITURA.
//
// Verifica se o estado do banco está pronto para ligar TENANT_CORE_ENABLED
// e as flags dependentes (ver docs/platform/27-flag-activation-matrix.md).
// Não corrige nada. Não liga flag nenhuma. Só conta e lista IDs técnicos.
//
// NUNCA imprime PII, mensagem, telefone, e-mail, token, payload de job,
// action_link ou conteúdo de campanha — só a contagem por checagem e no
// máximo MAX_IDS UUIDs por checagem.
//
// USO
//
//   # local (só localhost / 127.0.0.1):
//   APP_ENV=development node scripts/check-tenant-cutover-readiness.js
//
//   # staging (Supabase remoto) — exige TRÊS coisas explícitas:
//   ALLOW_REMOTE_STAGING_READ=true \
//   STAGING_SUPABASE_PROJECT_REF=<ref-do-projeto-de-staging> \
//   PRODUCTION_HOSTS=<hosts-de-producao-csv> \
//   APP_ENV=staging node scripts/check-tenant-cutover-readiness.js
//
//   exit 0  -> pronto (nenhuma pendência)
//   exit 2  -> há pendências de cutover (resolver antes de ligar as flags)
//   exit 1  -> erro de configuração / ambiente recusado
//
// CREDENCIAL MÍNIMA
//   O schema exige `service_role` para varrer as tabelas de negócio (RLS
//   ligada, sem role de leitura dedicada). Se você tiver uma chave de LEITURA
//   específica, exporte `SUPABASE_READONLY_KEY` — ela é usada no lugar do
//   service_role. Em qualquer caso o segredo fica SÓ em variável de ambiente.

import { guardEnvironment } from './check-campaigns-without-org.js';

export const MAX_IDS = 50;

// Cada checagem: { key, describe, run(client) -> { count, ids } }.
// `run` só chama .select() — nenhuma escrita.
const CHECKS = [
  {
    key: 'leads_sem_organizacao',
    describe: 'leads.organization_id nulo',
    async run(c) {
      return countIds(c, 'leads', (q) => q.is('organization_id', null));
    },
  },
  {
    key: 'events_sem_organizacao',
    describe: 'events.organization_id nulo',
    async run(c) {
      return countIds(c, 'events', (q) => q.is('organization_id', null));
    },
  },
  {
    key: 'campanhas_sem_organizacao',
    describe: 'campanhas.organization_id nulo (bloqueia CAMPAIGN_JOB_QUEUE_ENABLED)',
    async run(c) {
      return countIds(c, 'campanhas', (q) => q.is('organization_id', null));
    },
  },
  {
    key: 'integracoes_sem_organizacao',
    describe: 'integrations.organization_id nulo',
    async run(c) {
      return countIds(c, 'integrations', (q) => q.is('organization_id', null));
    },
  },
  {
    key: 'conversations_sem_organizacao',
    describe: 'conversations.organization_id nulo',
    async run(c) {
      return countIds(c, 'conversations', (q) => q.is('organization_id', null));
    },
  },
  {
    key: 'transactions_sem_organizacao',
    describe: 'transactions.organization_id nulo',
    async run(c) {
      return countIds(c, 'transactions', (q) => q.is('organization_id', null));
    },
  },
  {
    key: 'atendimentos_sem_organizacao',
    describe: 'atendimentos.organization_id nulo',
    async run(c) {
      return countIds(c, 'atendimentos', (q) => q.is('organization_id', null));
    },
  },
  {
    key: 'knowledge_base_sem_organizacao',
    describe: 'knowledge_base.organization_id nulo',
    async run(c) {
      return countIds(c, 'knowledge_base', (q) => q.is('organization_id', null));
    },
  },
  {
    key: 'doctors_sem_map',
    describe: 'doctors sem linha em organization_doctor_map',
    async run(c) {
      const { data: docs } = await c.from('doctors').select('id');
      const { data: maps } = await c.from('organization_doctor_map').select('doctor_id');
      const mapped = new Set((maps || []).map((m) => m.doctor_id));
      const missing = (docs || []).map((d) => d.id).filter((id) => !mapped.has(id));
      return { count: missing.length, ids: missing.slice(0, MAX_IDS) };
    },
  },
  {
    key: 'usuarios_sem_membership_ativa',
    describe: 'users ativos sem nenhuma membership ativa (e não platform_admin)',
    async run(c) {
      const [{ data: users }, { data: members }, { data: padmins }] = await Promise.all([
        c.from('users').select('id, ativo').eq('ativo', true),
        c.from('memberships').select('user_id, status').eq('status', 'active'),
        c.from('platform_admins').select('user_id'),
      ]);
      const active = new Set((members || []).map((m) => m.user_id));
      const padm = new Set((padmins || []).map((p) => p.user_id));
      const missing = (users || [])
        .map((u) => u.id)
        .filter((id) => !active.has(id) && !padm.has(id));
      return { count: missing.length, ids: missing.slice(0, MAX_IDS) };
    },
  },
  {
    key: 'usuarios_multi_org',
    describe: 'users com >1 membership ativa (precisam selecionar organização a cada sessão)',
    async run(c) {
      const { data: members } = await c
        .from('memberships')
        .select('user_id')
        .eq('status', 'active');
      const byUser = new Map();
      for (const m of members || []) byUser.set(m.user_id, (byUser.get(m.user_id) || 0) + 1);
      const multi = [...byUser.entries()].filter(([, n]) => n > 1).map(([id]) => id);
      return { count: multi.length, ids: multi.slice(0, MAX_IDS) };
    },
  },
  {
    key: 'memberships_ativas_sem_unidade',
    describe: 'memberships ativas cuja organização tem unidades mas a membership não tem nenhuma',
    async run(c) {
      const [{ data: members }, { data: mUnits }, { data: units }] = await Promise.all([
        c.from('memberships').select('id, organization_id, status').eq('status', 'active'),
        c.from('membership_units').select('membership_id'),
        c.from('units').select('organization_id').eq('status', 'active'),
      ]);
      const withUnit = new Set((mUnits || []).map((mu) => mu.membership_id));
      const orgsWithUnits = new Set((units || []).map((u) => u.organization_id));
      const bad = (members || [])
        .filter((m) => orgsWithUnits.has(m.organization_id) && !withUnit.has(m.id))
        .map((m) => m.id);
      return { count: bad.length, ids: bad.slice(0, MAX_IDS) };
    },
  },
  {
    key: 'divergencia_user_doctor_access_vs_memberships',
    describe: 'user_doctor_access com par (user,doctor) sem membership ativa correspondente na org do doctor',
    async run(c) {
      const [{ data: uda }, { data: maps }, { data: members }] = await Promise.all([
        c.from('user_doctor_access').select('user_id, doctor_id'),
        c.from('organization_doctor_map').select('doctor_id, organization_id'),
        c.from('memberships').select('user_id, organization_id, status').eq('status', 'active'),
      ]);
      const orgByDoctor = new Map((maps || []).map((m) => [m.doctor_id, m.organization_id]));
      const activePair = new Set((members || []).map((m) => `${m.user_id}:${m.organization_id}`));
      const diverging = [];
      for (const row of uda || []) {
        const org = orgByDoctor.get(row.doctor_id);
        if (!org || !activePair.has(`${row.user_id}:${org}`)) {
          diverging.push(`${row.user_id}:${row.doctor_id}`);
        }
      }
      return { count: diverging.length, ids: diverging.slice(0, MAX_IDS) };
    },
  },
  {
    key: 'convites_presos',
    describe: "organization_invitations em estado não-terminal há mais de 72h (pending/provisioning/ready/queued/sent)",
    async run(c) {
      const cutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
      return countIds(c, 'organization_invitations', (q) =>
        q.in('status', ['pending', 'provisioning', 'ready', 'queued', 'sent']).lt('created_at', cutoff),
      );
    },
  },
  {
    key: 'outbox_preso',
    describe: 'outbox_events não processados há mais de 24h',
    async run(c) {
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      return countIds(c, 'outbox_events', (q) => q.is('processed_at', null).lt('created_at', cutoff));
    },
  },
  {
    key: 'jobs_presos',
    describe: 'job_queue em dead_letter ou pending/leased há mais de 24h',
    async run(c) {
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const dead = await countIds(c, 'job_queue', (q) => q.eq('status', 'dead_letter'));
      const stuck = await countIds(c, 'job_queue', (q) =>
        q.in('status', ['pending', 'leased', 'retryable']).lt('created_at', cutoff),
      );
      return {
        count: dead.count + stuck.count,
        ids: [...dead.ids, ...stuck.ids].slice(0, MAX_IDS),
      };
    },
  },
  {
    key: 'reservas_de_quota_orfas',
    describe: 'usage_reservations em estado reserved há mais de 24h',
    async run(c) {
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      return countIds(c, 'usage_reservations', (q) =>
        q.eq('status', 'reserved').lt('created_at', cutoff),
      );
    },
  },
  {
    key: 'tokens_plaintext_restantes',
    describe: 'integrations com access_token/webhook_token em plaintext (só relevante quando TOKEN_ENCRYPTION estiver pronta)',
    async run(c) {
      const { data, error } = await c
        .from('integrations')
        .select('id, access_token, webhook_token')
        .or('access_token.not.is.null,webhook_token.not.is.null');
      if (error) throw error;
      const ids = (data || []).map((r) => r.id);
      return { count: ids.length, ids: ids.slice(0, MAX_IDS) };
    },
  },
];

// Helper: contagem exata + até MAX_IDS ids, aplicando um filtro read-only.
async function countIds(client, table, applyFilter) {
  const headQ = applyFilter(client.from(table).select('id', { count: 'exact', head: true }));
  const { count, error: cErr } = await headQ;
  if (cErr) throw cErr;
  const total = count || 0;
  if (total === 0) return { count: 0, ids: [] };
  const listQ = applyFilter(client.from(table).select('id')).limit(MAX_IDS);
  const { data, error } = await listQ;
  if (error) throw error;
  return { count: total, ids: (data || []).map((r) => r.id) };
}

// Roda todas as checagens. `client` já validado/criado pelo chamador.
export async function runReadiness({ client, appEnv, supabaseUrl, env = process.env, checks = CHECKS }) {
  const guard = guardEnvironment({ appEnv, supabaseUrl, env });
  if (!guard.ok) return { ok: false, code: 1, reason: guard.reason };
  if (!client) return { ok: false, code: 1, reason: 'cliente Supabase indisponível' };

  const results = [];
  for (const check of checks) {
    try {
      const r = await check.run(client);
      results.push({ key: check.key, describe: check.describe, count: r.count, ids: r.ids, truncated: r.count > r.ids.length });
    } catch (err) {
      // Uma tabela ausente (migration não aplicada) não deve abortar tudo —
      // reporta como erro da checagem, sem vazar mensagem crua com detalhe.
      const code = String(err?.code || err?.message || 'erro').split('\n')[0].slice(0, 80);
      results.push({ key: check.key, describe: check.describe, error: code });
    }
  }

  const failed = results.filter((r) => r.error);
  const pending = results.filter((r) => !r.error && r.count > 0);
  if (failed.length) return { ok: false, code: 1, reason: 'checagens com erro', results };
  return { ok: pending.length === 0, code: pending.length === 0 ? 0 : 2, results };
}

// --- CLI ---
if (process.argv[1]?.endsWith('check-tenant-cutover-readiness.js')) {
  const appEnv = process.env.APP_ENV || (process.env.NODE_ENV === 'test' ? 'test' : process.env.NODE_ENV);
  const supabaseUrl = process.env.SUPABASE_URL;

  const guard = guardEnvironment({ appEnv, supabaseUrl });
  if (!guard.ok) {
    console.error(`ERRO: ${guard.reason}`);
    process.exit(1);
  }

  const readonlyKey = process.env.SUPABASE_READONLY_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const key = readonlyKey || serviceKey;
  if (!supabaseUrl || !key) {
    console.error('ERRO: SUPABASE_URL / (SUPABASE_READONLY_KEY|SUPABASE_SERVICE_ROLE_KEY) ausentes');
    process.exit(1);
  }
  if (!readonlyKey) {
    console.error('AVISO: usando SUPABASE_SERVICE_ROLE_KEY (o schema exige — RLS sem grant de leitura dedicado).');
  }

  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(supabaseUrl, key, { auth: { persistSession: false } });

  const r = await runReadiness({ client, appEnv, supabaseUrl });
  for (const res of r.results || []) {
    if (res.error) {
      console.log(`  [ERRO] ${res.key}: ${res.error}`);
    } else if (res.count > 0) {
      console.log(`  [PENDENTE] ${res.key} (${res.count})${res.truncated ? ' — truncado' : ''}: ${res.ids.join(', ')}`);
      console.log(`            ${res.describe}`);
    } else {
      console.log(`  [ok] ${res.key}`);
    }
  }
  if (r.code === 0) console.log('\nPRONTO: nenhuma pendência de cutover.');
  else if (r.code === 2) console.log('\nPENDÊNCIAS ENCONTRADAS: resolver antes de ligar as flags (ver docs/platform/27-flag-activation-matrix.md).');
  else console.error(`\nERRO: ${r.reason || 'configuração/execução inválida'}`);
  process.exit(r.code);
}
