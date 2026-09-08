import { describe, it, expect, vi } from 'vitest';
import { prepareCutoverReadyScenario, guardWriteEnvironment } from '../scripts/prepare-cutover-ready-scenario.js';

const LOCAL = 'http://127.0.0.1:54321';
const REMOTE = 'https://stg-abc.supabase.co';

// Cliente Supabase mockado: builder chainável com select/update/upsert + eq/or.
// Um writeSpy registra TODA escrita (para provar que nada cross-tenant nem
// nenhuma escrita fora do previsto acontece).
function fakeClient(tables) {
  const writes = [];
  function q(name) {
    const rows = tables[name] || [];
    let op = 'select';
    let payload = null;
    const filters = [];
    const b = {
      select() { return b; },
      eq(col, val) { filters.push((r) => r[col] === val); return b; },
      or(expr) {
        const cols = expr.split(',').map((s) => s.split('.')[0]);
        filters.push((r) => cols.some((c) => r[c] != null));
        return b;
      },
      update(p) { op = 'update'; payload = p; return b; },
      upsert(p, opts) { op = 'upsert'; payload = p; b._opts = opts; return b; },
      then(resolve) {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (op === 'select') return resolve({ data: matched.map((r) => ({ ...r })), error: null });
        if (op === 'update') {
          for (const r of matched) { writes.push({ table: name, op, id: r.id ?? r.user_id ?? null, payload }); Object.assign(r, payload); }
          return resolve({ error: null });
        }
        if (op === 'upsert') {
          const items = Array.isArray(payload) ? payload : [payload];
          for (const it of items) {
            const dup = rows.find((r) => r.membership_id === it.membership_id && r.unit_id === it.unit_id);
            if (dup && b._opts?.ignoreDuplicates) continue;
            writes.push({ table: name, op, payload: it });
            rows.push({ ...it });
          }
          return resolve({ error: null });
        }
        return resolve({ error: null });
      },
    };
    return b;
  }
  return { client: { from: (n) => q(n) }, writes, tables };
}

// vault fake: registra o AAD/scope usado, nunca expõe valor de token.
function fakeVault() {
  const calls = [];
  return {
    __setCryptoStateForTests: vi.fn(),
    CredentialVault: {
      buildIntegrationCredentialPatch({ id, doctorId, gateway, values }) {
        calls.push({ id, doctorId, gateway, fields: Object.keys(values) });
        const patch = { token_encryption_migrated_at: '2026-01-01T00:00:00Z' };
        if (values.access_token != null) patch.access_token_encrypted = `ENC(${id}:access)`;
        if (values.webhook_token != null) {
          patch.webhook_token_encrypted = `ENC(${id}:webhook)`;
          patch.webhook_token_lookup = `LOOKUP(${id})`;
        }
        return patch;
      },
    },
    calls,
  };
}

const baseTables = () => ({
  memberships: [
    { id: 'mOwnerA', organization_id: 'orgA', user_id: 'ownerA', status: 'active' },
    { id: 'mCloserA', organization_id: 'orgA', user_id: 'multi', status: 'active' },
    { id: 'mCloserB', organization_id: 'orgB', user_id: 'multi', status: 'active' },
  ],
  membership_units: [{ membership_id: 'mCloserA', unit_id: 'uA' }, { membership_id: 'mCloserB', unit_id: 'uB' }],
  units: [{ id: 'uA', organization_id: 'orgA', status: 'active' }, { id: 'uB', organization_id: 'orgB', status: 'active' }],
  organization_doctor_map: [
    { organization_id: 'orgA', default_unit_id: 'uA' },
    { organization_id: 'orgB', default_unit_id: 'uB' },
  ],
  users: [
    { id: 'ownerA', ativo: true },
    { id: 'multi', ativo: true },
    { id: 'orfao', ativo: true },
    { id: 'padm', ativo: true },
  ],
  platform_admins: [{ user_id: 'padm' }],
  integrations: [
    { id: 'i1', doctor_id: 'docA', gateway: 'whatsapp', access_token: 'segredo-A', webhook_token: 'wht-A', access_token_encrypted: null, webhook_token_encrypted: null },
    { id: 'i2', doctor_id: 'docB', gateway: 'whatsapp', access_token: null, webhook_token: 'wht-B', access_token_encrypted: null, webhook_token_encrypted: null },
  ],
});

const keyringEnv = { TOKEN_ENCRYPTION_KEYRING: '{"v1":"x"}', TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1', TOKEN_LOOKUP_HMAC_KEY: 'h' };
const run = (fc, vault, over = {}) => prepareCutoverReadyScenario({
  client: fc.client, appEnv: 'development', supabaseUrl: LOCAL, vault, keyringEnv, ...over,
});

describe('guardWriteEnvironment', () => {
  it('production -> recusa', () => expect(guardWriteEnvironment({ appEnv: 'production', supabaseUrl: LOCAL }).ok).toBe(false));
  it('staging -> recusa (script de escrita nunca toca remoto)', () => expect(guardWriteEnvironment({ appEnv: 'staging', supabaseUrl: REMOTE }).ok).toBe(false));
  it('development + host remoto -> recusa', () => expect(guardWriteEnvironment({ appEnv: 'development', supabaseUrl: REMOTE }).ok).toBe(false));
  it('development + localhost -> permite', () => expect(guardWriteEnvironment({ appEnv: 'development', supabaseUrl: LOCAL }).ok).toBe(true));
  it('test + 127.0.0.1 -> permite', () => expect(guardWriteEnvironment({ appEnv: 'test', supabaseUrl: LOCAL }).ok).toBe(true));
});

describe('prepareCutoverReadyScenario', () => {
  it('production -> code 1, nenhuma escrita', async () => {
    const fc = fakeClient(baseTables());
    const r = await run(fc, fakeVault(), { appEnv: 'production' });
    expect(r.code).toBe(1);
    expect(fc.writes).toHaveLength(0);
  });

  it('host remoto -> code 1, nenhuma escrita', async () => {
    const fc = fakeClient(baseTables());
    const r = await run(fc, fakeVault(), { supabaseUrl: REMOTE });
    expect(r.code).toBe(1);
    expect(fc.writes).toHaveLength(0);
  });

  it('sem keyring -> code 1 antes de cifrar', async () => {
    const fc = fakeClient(baseTables());
    const r = await run(fc, fakeVault(), { keyringEnv: {} });
    expect(r.code).toBe(1);
    expect(r.reason).toMatch(/KEYRING/);
  });

  it('caminho feliz: vincula unidade ao owner, desativa órfão, cifra integrações, preserva multi-org', async () => {
    const fc = fakeClient(baseTables());
    const vault = fakeVault();
    const r = await run(fc, vault);
    expect(r.code).toBe(0);
    expect(r.counts).toEqual({
      memberships_unidade_vinculada: 1,   // só mOwnerA estava sem unidade
      contas_orfas_desativadas: 1,        // orfao
      integracoes_cifradas: 2,            // i1 e i2
      multi_org_preservados: 1,           // multi
    });
    // owner recebeu a unidade default da org
    expect(fc.tables.membership_units.find((mu) => mu.membership_id === 'mOwnerA')?.unit_id).toBe('uA');
    // órfão desativado; multi-org e platform_admin intactos
    expect(fc.tables.users.find((u) => u.id === 'orfao').ativo).toBe(false);
    expect(fc.tables.users.find((u) => u.id === 'multi').ativo).toBe(true);
    expect(fc.tables.users.find((u) => u.id === 'padm').ativo).toBe(true);
    // AAD/scope por doctor — nunca cross-tenant
    expect(vault.calls.map((c) => `${c.id}:${c.doctorId}`).sort()).toEqual(['i1:docA', 'i2:docB']);
    // integrações: ciphertext presente, plaintext zerado
    const i1 = fc.tables.integrations.find((x) => x.id === 'i1');
    expect(i1.access_token).toBeNull();
    expect(i1.webhook_token).toBeNull();
    expect(i1.access_token_encrypted).toBe('ENC(i1:access)');
  });

  it('idempotente: 2ª execução não faz nada', async () => {
    const fc = fakeClient(baseTables());
    const vault = fakeVault();
    await run(fc, vault);
    const writesApos1 = fc.writes.length;
    const r2 = await run(fc, vault);
    expect(r2.code).toBe(0);
    expect(r2.counts).toEqual({ memberships_unidade_vinculada: 0, contas_orfas_desativadas: 0, integracoes_cifradas: 0, multi_org_preservados: 1 });
    expect(fc.writes.length).toBe(writesApos1); // nenhuma escrita nova
  });

  it('não desativa usuário multi-org nem platform_admin; multi-org continua exigindo seleção (não escolhe org)', async () => {
    const fc = fakeClient(baseTables());
    await run(fc, fakeVault());
    // nenhuma escrita mexeu em memberships de "multi" (continua com 2 orgs)
    expect(fc.tables.memberships.filter((m) => m.user_id === 'multi' && m.status === 'active')).toHaveLength(2);
    // nenhuma escrita em `memberships` (só em membership_units/users/integrations)
    expect(fc.writes.some((w) => w.table === 'memberships')).toBe(false);
  });

  it('saída só com contagens + UUIDs técnicos — sem token/plaintext/ciphertext', async () => {
    const fc = fakeClient(baseTables());
    const r = await run(fc, fakeVault());
    const dump = JSON.stringify(r);
    expect(dump).not.toMatch(/segredo-|wht-|ENC\(|LOOKUP\(/);
  });
});
