import { describe, it, expect, vi } from 'vitest';
import { runInventory, guardEnvironment } from '../scripts/check-campaigns-without-org.js';

const LOCAL = 'http://127.0.0.1:54321';
const REMOTE = 'https://stg-abc.supabase.co';

// Cliente Supabase mockado: builder chainável só com SELECT. Um spy garante
// que nenhum método de ESCRITA é chamado.
function fakeClient(rows) {
  const writeSpy = vi.fn();
  const client = {
    from() {
      const q = {
        _head: false, _limit: undefined,
        select(_c, opts) { this._head = !!opts?.head; return this; },
        is() { return this; },
        order() { return this; },
        limit(n) { this._limit = n; return this; },
        insert(...a) { writeSpy('insert', ...a); return this; },
        update(...a) { writeSpy('update', ...a); return this; },
        delete(...a) { writeSpy('delete', ...a); return this; },
        upsert(...a) { writeSpy('upsert', ...a); return this; },
        then(resolve) {
          if (this._head) return resolve({ count: rows.length, error: null });
          return resolve({ data: rows.slice(0, this._limit ?? rows.length), error: null });
        },
      };
      return q;
    },
    rpc(...a) { writeSpy('rpc', ...a); return Promise.resolve({ data: null, error: null }); },
  };
  return { client, writeSpy };
}

describe('guardEnvironment', () => {
  it('APP_ENV ausente -> recusa', () => {
    expect(guardEnvironment({ appEnv: undefined }).ok).toBe(false);
  });
  it('production -> sempre recusa', () => {
    expect(guardEnvironment({ appEnv: 'production', supabaseUrl: LOCAL, env: { ALLOW_REMOTE_STAGING_READ: 'true' } }).ok).toBe(false);
  });
  it('development + localhost -> permite', () => {
    expect(guardEnvironment({ appEnv: 'development', supabaseUrl: LOCAL }).ok).toBe(true);
    expect(guardEnvironment({ appEnv: 'development', supabaseUrl: 'http://localhost:54321' }).ok).toBe(true);
  });
  it('development + host remoto (*.supabase.co) -> recusa', () => {
    expect(guardEnvironment({ appEnv: 'development', supabaseUrl: REMOTE }).ok).toBe(false);
    expect(guardEnvironment({ appEnv: 'test', supabaseUrl: REMOTE }).ok).toBe(false);
  });
  it('staging remoto SEM ALLOW_REMOTE_STAGING_READ -> recusa (fail closed)', () => {
    const r = guardEnvironment({ appEnv: 'staging', supabaseUrl: REMOTE, env: { PRODUCTION_HOSTS: 'app.prod.example', STAGING_SUPABASE_PROJECT_REF: 'stg-abc' } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ALLOW_REMOTE_STAGING_READ/);
  });
  it('staging remoto COM confirmação + ref correto + host fora de PRODUCTION_HOSTS -> permite', () => {
    const r = guardEnvironment({
      appEnv: 'staging', supabaseUrl: REMOTE,
      env: { ALLOW_REMOTE_STAGING_READ: 'true', PRODUCTION_HOSTS: 'app.prod.example,prod-xyz.supabase.co', STAGING_SUPABASE_PROJECT_REF: 'stg-abc' },
    });
    expect(r.ok).toBe(true);
  });
  it('staging apontando para um host de PRODUCTION_HOSTS -> recusa', () => {
    const r = guardEnvironment({
      appEnv: 'staging', supabaseUrl: 'https://prod-xyz.supabase.co',
      env: { ALLOW_REMOTE_STAGING_READ: 'true', PRODUCTION_HOSTS: 'prod-xyz.supabase.co', STAGING_SUPABASE_PROJECT_REF: 'prod-xyz' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PRODUCTION_HOSTS/);
  });
  it('staging sem STAGING_SUPABASE_PROJECT_REF -> recusa (sem inferência)', () => {
    const r = guardEnvironment({ appEnv: 'staging', supabaseUrl: REMOTE, env: { ALLOW_REMOTE_STAGING_READ: 'true', PRODUCTION_HOSTS: 'app.prod.example' } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/STAGING_SUPABASE_PROJECT_REF/);
  });
  it('staging com ref que NÃO bate com o host -> recusa', () => {
    const r = guardEnvironment({
      appEnv: 'staging', supabaseUrl: REMOTE,
      env: { ALLOW_REMOTE_STAGING_READ: 'true', PRODUCTION_HOSTS: 'app.prod.example', STAGING_SUPABASE_PROJECT_REF: 'outro-ref' },
    });
    expect(r.ok).toBe(false);
  });
  it('staging sem PRODUCTION_HOSTS -> recusa (não dá pra garantir que não é prod)', () => {
    const r = guardEnvironment({ appEnv: 'staging', supabaseUrl: REMOTE, env: { ALLOW_REMOTE_STAGING_READ: 'true', STAGING_SUPABASE_PROJECT_REF: 'stg-abc' } });
    expect(r.ok).toBe(false);
  });
});

describe('runInventory', () => {
  const stagingEnv = { ALLOW_REMOTE_STAGING_READ: 'true', PRODUCTION_HOSTS: 'app.prod.example', STAGING_SUPABASE_PROJECT_REF: 'stg-abc' };

  it('production -> exit 1', async () => {
    const { client } = fakeClient([]);
    expect((await runInventory({ client, appEnv: 'production', supabaseUrl: LOCAL })).code).toBe(1);
  });

  it('development + localhost + nenhuma pendência -> exit 0, sem escrita', async () => {
    const { client, writeSpy } = fakeClient([]);
    const r = await runInventory({ client, appEnv: 'development', supabaseUrl: LOCAL });
    expect(r).toMatchObject({ ok: true, code: 0, total: 0, ids: [] });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('development + *.supabase.co -> exit 1 (nunca cria/usa cliente pra leitura remota)', async () => {
    const { client, writeSpy } = fakeClient([{ id: 'x' }]);
    const r = await runInventory({ client, appEnv: 'development', supabaseUrl: REMOTE });
    expect(r.code).toBe(1);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('staging remoto confirmado + pendências -> exit 2, SÓ uuids, sem URL/chave/PII, sem escrita', async () => {
    const rows = [{ id: '11111111-1111-4111-8111-111111111111' }, { id: '22222222-2222-4222-8222-222222222222' }];
    const { client, writeSpy } = fakeClient(rows);
    const r = await runInventory({ client, appEnv: 'staging', supabaseUrl: REMOTE, env: stagingEnv });
    expect(r.code).toBe(2);
    expect(r.total).toBe(2);
    expect(r.ids).toEqual(rows.map((x) => x.id));
    const dump = JSON.stringify(r);
    expect(dump).not.toMatch(/supabase\.co|nome|mensagem|telefone|conteudo|token|key|secret/i);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('staging remoto SEM confirmação -> exit 1 antes de tocar no cliente', async () => {
    const { client, writeSpy } = fakeClient([{ id: 'x' }]);
    const r = await runInventory({ client, appEnv: 'staging', supabaseUrl: REMOTE, env: { PRODUCTION_HOSTS: 'app.prod.example', STAGING_SUPABASE_PROJECT_REF: 'stg-abc' } });
    expect(r.code).toBe(1);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('mais de MAX_IDS pendências -> truncated:true, no máximo 50 ids', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ id: `${i}`.padStart(8, '0') + '-0000-4000-8000-000000000000' }));
    const { client } = fakeClient(rows);
    const r = await runInventory({ client, appEnv: 'staging', supabaseUrl: REMOTE, env: stagingEnv });
    expect(r.code).toBe(2);
    expect(r.total).toBe(80);
    expect(r.ids.length).toBe(50);
    expect(r.truncated).toBe(true);
  });
});
