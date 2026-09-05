// FASE 2.8 — inventário PRÉ-flag: detecta campanhas sem organization_id.
//
// Com CAMPAIGN_JOB_QUEUE_ENABLED=true, uma campanha sem organization_id é
// recusada (409 tenant_backfill_required) — a fila e a quota são
// tenant-scoped. RODE ISTO ANTES de ligar a flag para saber quantas/quais
// campanhas precisam de backfill de organização.
//
// SOMENTE LEITURA. Nunca executa insert/update/delete/RPC de escrita.
// Nunca imprime URL, chave, header, telefone, nome ou conteúdo de campanha —
// só a contagem e no máximo MAX_IDS UUIDs técnicos.
//
// USO
//
//   # local (só localhost / 127.0.0.1):
//   APP_ENV=development node scripts/check-campaigns-without-org.js
//
//   # staging (Supabase remoto) — exige TRÊS coisas explícitas:
//   ALLOW_REMOTE_STAGING_READ=true \
//   STAGING_SUPABASE_PROJECT_REF=<ref-do-projeto-de-staging> \
//   PRODUCTION_HOSTS=<hosts-de-producao-csv> \
//   APP_ENV=staging node scripts/check-campaigns-without-org.js
//
//   exit 0  -> nenhuma campanha sem organização (seguro ligar a flag)
//   exit 2  -> existem campanhas sem organização (backfill primeiro)
//   exit 1  -> erro de configuração / ambiente recusado
//
// CREDENCIAL MÍNIMA
//   O schema atual exige `service_role` para ler `campanhas` (RLS ligada,
//   sem grant para role de leitura dedicada). Se você tiver uma chave de
//   LEITURA específica, exporte `SUPABASE_READONLY_KEY` e ela é usada no
//   lugar do service_role. Em QUALQUER caso o segredo fica SÓ em variável de
//   ambiente — nunca em argumento de linha de comando, saída ou arquivo.

export const MAX_IDS = 50;

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}
function isLocalHost(host) {
  if (!host) return false;
  const h = host.split(':')[0];
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}
function csv(v) {
  return String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Decide se pode conectar. NÃO cria cliente — só valida o ambiente.
// Retorna { ok, reason }.
export function guardEnvironment({ appEnv, supabaseUrl, env = process.env }) {
  if (!appEnv) return { ok: false, reason: 'APP_ENV ausente — escolha development, test ou staging explicitamente' };

  if (appEnv === 'production') {
    return { ok: false, reason: 'APP_ENV=production — este inventário NUNCA roda contra produção' };
  }

  const host = supabaseUrl ? hostOf(supabaseUrl) : null;

  if (appEnv === 'development' || appEnv === 'test') {
    if (!supabaseUrl) return { ok: false, reason: 'SUPABASE_URL ausente' };
    if (!isLocalHost(host)) {
      return { ok: false, reason: `APP_ENV=${appEnv} só permite localhost/127.0.0.1 — host "${host}" recusado` };
    }
    return { ok: true };
  }

  if (appEnv === 'staging') {
    if (env.ALLOW_REMOTE_STAGING_READ !== 'true') {
      // fail closed ANTES de qualquer cliente/conexão
      return { ok: false, reason: 'staging exige ALLOW_REMOTE_STAGING_READ=true (confirmação explícita de leitura remota)' };
    }
    if (!supabaseUrl || !host) return { ok: false, reason: 'SUPABASE_URL ausente/inválida' };
    const prodHosts = csv(env.PRODUCTION_HOSTS);
    if (prodHosts.length === 0) {
      return { ok: false, reason: 'PRODUCTION_HOSTS não configurado — sem a lista não dá pra garantir que o host não é produção' };
    }
    if (prodHosts.includes(host) || prodHosts.includes(host.split(':')[0])) {
      return { ok: false, reason: 'SUPABASE_URL aponta para um host listado em PRODUCTION_HOSTS — recusado' };
    }
    const ref = env.STAGING_SUPABASE_PROJECT_REF;
    if (!ref) {
      return { ok: false, reason: 'STAGING_SUPABASE_PROJECT_REF ausente — o projeto de staging precisa ser identificado explicitamente, sem inferência' };
    }
    // o host tem que corresponder EXATAMENTE ao ref informado (sem adivinhar).
    if (host !== `${ref.toLowerCase()}.supabase.co` && host !== `db.${ref.toLowerCase()}.supabase.co`) {
      return { ok: false, reason: 'SUPABASE_URL não corresponde a STAGING_SUPABASE_PROJECT_REF — recusado (nenhuma inferência)' };
    }
    return { ok: true };
  }

  return { ok: false, reason: `APP_ENV=${appEnv} não suportado` };
}

// Executa o inventário. `client` já validado/criado pelo chamador. Só faz
// SELECT — nenhum método de escrita é chamado.
export async function runInventory({ client, appEnv, supabaseUrl, env = process.env }) {
  const guard = guardEnvironment({ appEnv, supabaseUrl, env });
  if (!guard.ok) return { ok: false, code: 1, reason: guard.reason };
  if (!client) return { ok: false, code: 1, reason: 'cliente Supabase indisponível' };

  const { count, error: countErr } = await client
    .from('campanhas')
    .select('id', { count: 'exact', head: true })
    .is('organization_id', null);
  if (countErr) return { ok: false, code: 1, reason: `erro ao contar: ${countErr.message}` };

  const total = count || 0;
  if (total === 0) return { ok: true, code: 0, total: 0, ids: [] };

  const { data, error } = await client
    .from('campanhas')
    .select('id')
    .is('organization_id', null)
    .order('criado_em', { ascending: true })
    .limit(MAX_IDS);
  if (error) return { ok: false, code: 1, reason: `erro ao listar: ${error.message}` };

  return { ok: false, code: 2, total, ids: (data || []).map((r) => r.id), truncated: total > MAX_IDS };
}

// --- CLI ---
if (process.argv[1]?.endsWith('check-campaigns-without-org.js')) {
  const appEnv = process.env.APP_ENV || (process.env.NODE_ENV === 'test' ? 'test' : process.env.NODE_ENV);
  const supabaseUrl = process.env.SUPABASE_URL;

  // fail closed ANTES de tocar em qualquer credencial/cliente.
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
    console.error('AVISO: usando SUPABASE_SERVICE_ROLE_KEY (o schema atual exige — RLS em campanhas sem grant de leitura dedicado).');
  }

  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(supabaseUrl, key, { auth: { persistSession: false } });

  const r = await runInventory({ client, appEnv, supabaseUrl });
  if (r.code === 0) {
    console.log('OK: nenhuma campanha sem organization_id.');
  } else if (r.code === 2) {
    console.log(`PENDENTE: ${r.total} campanha(s) sem organization_id.`);
    console.log(`IDs (até ${MAX_IDS}${r.truncated ? ', truncado' : ''}): ${r.ids.join(', ')}`);
    console.log('Faça o backfill de organização nessas campanhas ANTES de ligar CAMPAIGN_JOB_QUEUE_ENABLED.');
  } else {
    console.error(`ERRO: ${r.reason}`);
  }
  process.exit(r.code);
}
