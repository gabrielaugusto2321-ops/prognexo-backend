// FASE 2.10 — prepara um CENÁRIO SINTÉTICO cutover-ready a partir do seed
// adversarial base (supabase/seed.sql), SEM enfraquecer as fixtures que os
// testes de RLS precisam.
//
// O que faz (idempotente):
//   1. cada membership ATIVA cuja organização tem unidade ativa e que não tem
//      nenhuma `membership_units` -> vincula à unidade default do
//      organization_doctor_map (ou à 1ª unidade ativa da org);
//   2. conta órfã (user ATIVO, sem membership, não platform_admin) -> DESATIVA
//      (`ativo=false`). Regra explícita: conta sem organização não acessa
//      tenant nenhum; desativar é a ação segura e reversível (db reset
//      restaura). NÃO cria membership — a organização certa é decisão humana;
//   3. tokens plaintext de `integrations` -> cifra com o mecanismo da FASE 2.2
//      (CredentialVault.buildIntegrationCredentialPatch) e ZERA as colunas
//      plaintext. Nunca imprime plaintext nem ciphertext.
//   4. o usuário multi-org é PRESERVADO como está (2 memberships ativas) —
//      o cutover-ready convive com multi-org; a seleção obrigatória é provada
//      pelos testes, não "resolvida" escolhendo uma org.
//
// SOMENTE development/test + localhost. Recusa qualquer host remoto.
// Relatório final: só contagens + UUIDs técnicos.

const ORFAO_RULE = 'deactivate'; // regra explícita da pendência (D -> ação automática segura)

function hostOf(url) { try { return new URL(url).host.toLowerCase(); } catch { return null; } }
function isLocalHost(host) {
  if (!host) return false;
  const h = host.split(':')[0];
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}

// Guarda ESTRITA para um script que ESCREVE: só dev/test + localhost.
export function guardWriteEnvironment({ appEnv, supabaseUrl }) {
  if (appEnv !== 'development' && appEnv !== 'test') {
    return { ok: false, reason: `APP_ENV=${appEnv || '(ausente)'} — a preparação só roda em development/test` };
  }
  if (!supabaseUrl) return { ok: false, reason: 'SUPABASE_URL ausente' };
  if (!isLocalHost(hostOf(supabaseUrl))) {
    return { ok: false, reason: `SUPABASE_URL "${hostOf(supabaseUrl)}" não é localhost — recusado (script de escrita nunca toca host remoto)` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
export async function prepareCutoverReadyScenario({ client, appEnv, supabaseUrl, vault, keyringEnv }) {
  const guard = guardWriteEnvironment({ appEnv, supabaseUrl });
  if (!guard.ok) return { ok: false, code: 1, reason: guard.reason };
  if (!client) return { ok: false, code: 1, reason: 'cliente Supabase indisponível' };

  const report = { memberships_unidade_vinculada: [], contas_orfas_desativadas: [], integracoes_cifradas: [], multi_org_preservados: [] };

  // --- 1. memberships ativas sem unidade -----------------------------------
  const [{ data: members }, { data: mUnits }, { data: units }, { data: maps }] = await Promise.all([
    client.from('memberships').select('id, organization_id, user_id, status').eq('status', 'active'),
    client.from('membership_units').select('membership_id, unit_id'),
    client.from('units').select('id, organization_id, status').eq('status', 'active'),
    client.from('organization_doctor_map').select('organization_id, default_unit_id'),
  ]);
  const withUnit = new Set((mUnits || []).map((mu) => mu.membership_id));
  const defaultUnitByOrg = new Map((maps || []).map((m) => [m.organization_id, m.default_unit_id]));
  const firstUnitByOrg = new Map();
  for (const u of units || []) if (!firstUnitByOrg.has(u.organization_id)) firstUnitByOrg.set(u.organization_id, u.id);

  for (const m of members || []) {
    if (withUnit.has(m.id)) continue;
    const unitId = defaultUnitByOrg.get(m.organization_id) || firstUnitByOrg.get(m.organization_id);
    if (!unitId) continue; // org sem unidade ativa -> nada a fazer aqui
    const { error } = await client.from('membership_units').upsert(
      { membership_id: m.id, unit_id: unitId },
      { onConflict: 'membership_id,unit_id', ignoreDuplicates: true },
    );
    if (error) return { ok: false, code: 1, reason: `falha ao vincular unidade: ${String(error.message).split('\n')[0]}` };
    report.memberships_unidade_vinculada.push(m.id);
  }

  // --- 2. contas órfãs ativas ---------------------------------------------
  const [{ data: allActiveUsers }, { data: allActiveMembers }, { data: padmins }] = await Promise.all([
    client.from('users').select('id').eq('ativo', true),
    client.from('memberships').select('user_id').eq('status', 'active'),
    client.from('platform_admins').select('user_id'),
  ]);
  const memberSet = new Set((allActiveMembers || []).map((m) => m.user_id));
  const padminSet = new Set((padmins || []).map((p) => p.user_id));
  for (const u of allActiveUsers || []) {
    if (memberSet.has(u.id) || padminSet.has(u.id)) continue;
    if (ORFAO_RULE === 'deactivate') {
      const { error } = await client.from('users').update({ ativo: false }).eq('id', u.id).eq('ativo', true);
      if (error) return { ok: false, code: 1, reason: `falha ao desativar conta órfã: ${String(error.message).split('\n')[0]}` };
      report.contas_orfas_desativadas.push(u.id);
    }
  }

  // --- 3. tokens plaintext -> ciphertext (FASE 2.2) ----------------------
  // Exige keyring válido no ambiente. NUNCA loga valor de token.
  if (!keyringEnv?.TOKEN_ENCRYPTION_KEYRING || !keyringEnv?.TOKEN_ENCRYPTION_ACTIVE_KEY) {
    return { ok: false, code: 1, reason: 'TOKEN_ENCRYPTION_KEYRING/ACTIVE_KEY ausentes — necessários para cifrar os tokens sintéticos' };
  }
  vault.__setCryptoStateForTests({
    TOKEN_ENCRYPTION_ENABLED: 'true',
    TOKEN_ENCRYPTION_DUAL_WRITE: 'false',
    TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ: 'false',
    TOKEN_ENCRYPTION_KEYRING: keyringEnv.TOKEN_ENCRYPTION_KEYRING,
    TOKEN_ENCRYPTION_ACTIVE_KEY: keyringEnv.TOKEN_ENCRYPTION_ACTIVE_KEY,
    TOKEN_LOOKUP_HMAC_KEY: keyringEnv.TOKEN_LOOKUP_HMAC_KEY,
  });

  const { data: integ } = await client
    .from('integrations')
    .select('id, doctor_id, gateway, access_token, webhook_token, access_token_encrypted, webhook_token_encrypted')
    .or('access_token.not.is.null,webhook_token.not.is.null');

  for (const row of integ || []) {
    const values = {};
    if (row.access_token != null) values.access_token = row.access_token;
    if (row.webhook_token != null) values.webhook_token = row.webhook_token;
    if (Object.keys(values).length === 0) continue;

    // ciphertext via o mesmo builder usado em produção
    const patch = vault.CredentialVault.buildIntegrationCredentialPatch({
      id: row.id, doctorId: row.doctor_id, gateway: row.gateway, values,
    });
    // cutover-ready = migração concluída: zera o plaintext DEPOIS de ter o ciphertext
    if ('access_token' in values) patch.access_token = null;
    if ('webhook_token' in values) patch.webhook_token = null;

    const { error } = await client.from('integrations').update(patch).eq('id', row.id);
    if (error) return { ok: false, code: 1, reason: `falha ao cifrar integração: ${String(error.message).split('\n')[0]}` };
    report.integracoes_cifradas.push(row.id);
  }

  // --- 4. multi-org: só registra, não altera ----------------------------
  const byUser = new Map();
  for (const m of allActiveMembers || []) byUser.set(m.user_id, (byUser.get(m.user_id) || 0) + 1);
  report.multi_org_preservados = [...byUser.entries()].filter(([, n]) => n > 1).map(([id]) => id);

  return {
    ok: true,
    code: 0,
    counts: {
      memberships_unidade_vinculada: report.memberships_unidade_vinculada.length,
      contas_orfas_desativadas: report.contas_orfas_desativadas.length,
      integracoes_cifradas: report.integracoes_cifradas.length,
      multi_org_preservados: report.multi_org_preservados.length,
    },
    ids: report,
    orfao_rule: ORFAO_RULE,
  };
}

// --- CLI ---
if (process.argv[1]?.endsWith('prepare-cutover-ready-scenario.js')) {
  // Saída limpa no Windows: process.exit() abrupto pode colidir com o teardown
  // do socket keepalive do supabase-js (Assertion failed em src/win/async.c).
  // Deixa o loop drenar; força saída só se algo travar.
  const finish = (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 3000).unref(); };
  await (async () => {
    const appEnv = process.env.APP_ENV || (process.env.NODE_ENV === 'test' ? 'test' : process.env.NODE_ENV);
    const supabaseUrl = process.env.SUPABASE_URL;

    const guard = guardWriteEnvironment({ appEnv, supabaseUrl });
    if (!guard.ok) { console.error(`ERRO: ${guard.reason}`); return finish(1); }

    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !key) { console.error('ERRO: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes'); return finish(1); }

    const { createClient } = await import('@supabase/supabase-js');
    const vault = await import('../src/lib/credentialVault.js');
    const client = createClient(supabaseUrl, key, { auth: { persistSession: false } });

    const r = await prepareCutoverReadyScenario({
      client, appEnv, supabaseUrl, vault,
      keyringEnv: {
        TOKEN_ENCRYPTION_KEYRING: process.env.TOKEN_ENCRYPTION_KEYRING,
        TOKEN_ENCRYPTION_ACTIVE_KEY: process.env.TOKEN_ENCRYPTION_ACTIVE_KEY,
        TOKEN_LOOKUP_HMAC_KEY: process.env.TOKEN_LOOKUP_HMAC_KEY,
      },
    });
    if (!r.ok) { console.error(`ERRO: ${r.reason}`); return finish(r.code); }
    console.log('CENÁRIO CUTOVER-READY PREPARADO (idempotente):');
    console.log(`  memberships com unidade vinculada: ${r.counts.memberships_unidade_vinculada}  -> ${r.ids.memberships_unidade_vinculada.join(', ') || '(nenhuma)'}`);
    console.log(`  contas órfãs desativadas (regra=${r.orfao_rule}): ${r.counts.contas_orfas_desativadas}  -> ${r.ids.contas_orfas_desativadas.join(', ') || '(nenhuma)'}`);
    console.log(`  integrações com token cifrado + plaintext zerado: ${r.counts.integracoes_cifradas}  -> ${r.ids.integracoes_cifradas.join(', ') || '(nenhuma)'}`);
    console.log(`  usuários multi-org preservados: ${r.counts.multi_org_preservados}  -> ${r.ids.multi_org_preservados.join(', ') || '(nenhum)'}`);
    return finish(0);
  })();
}
