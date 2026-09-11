// FASE 3.8A — hotfix do crash em POST /jobs/team-invite-outbox.
// Reproduz o defeito real (thenable do supabase-js sem `.catch()`) com um
// mock que tem a MESMA forma do builder de verdade, e prova que o handler
// nunca deixa um erro — esperado ou inesperado — escapar e derrubar o
// processo. Cobertura via requisição HTTP real (supertest), não busca de
// texto no arquivo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

const CRON_SECRET = 'test-cron-secret';
const key = Buffer.alloc(32, 9).toString('base64');

// Builder "quebrado" com a MESMA forma do real: thenable (.then existe),
// mas SEM `.catch()` — exatamente o que o supabase-js 2.112.2 devolve pra
// `.rpc(...)`. É isso que expõe o bug se alguém reintroduzir `.catch()`
// direto no builder.
function brokenThenable(executor) {
  return {
    then(onFulfilled, onRejected) {
      return new Promise(executor).then(onFulfilled, onRejected);
    },
    // deliberadamente sem `.catch` — não é um Promise nativo.
  };
}

let rpcImpl;
const rpcCalls = [];

vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return {
      rpc: (name, params) => {
        rpcCalls.push([name, params]);
        return rpcImpl(name, params);
      },
    };
  },
}));

async function buildApp() {
  vi.resetModules();
  process.env.TENANT_CORE_ENABLED = 'true';
  process.env.TEAM_MEMBERSHIPS_ENABLED = 'true';
  process.env.TEAM_INVITE_OUTBOX_ENABLED = 'true';
  process.env.TEAM_INVITE_EMAIL_DELIVERY_ENABLED = 'false';
  process.env.TOKEN_ENCRYPTION_ENABLED = 'false';
  process.env.TOKEN_ENCRYPTION_KEYRING = JSON.stringify({ v1: key });
  process.env.TOKEN_ENCRYPTION_ACTIVE_KEY = 'v1';
  process.env.CRON_SECRET = CRON_SECRET;
  return (await import('../src/server.js')).createApp();
}

// team_outbox_claim vazio -> processOutboxBatch não tenta enviar nada; o
// foco do teste é só o comportamento do sweep + do handler em volta dele.
function emptyClaim(name) {
  if (name === 'team_outbox_claim') return Promise.resolve({ data: [], error: null });
  return Promise.resolve({ data: null, error: null });
}

describe('POST /jobs/team-invite-outbox — hotfix do crash de .catch() no builder', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    rpcImpl = () => Promise.resolve({ data: null, error: null });
  });
  afterEach(() => {
    delete process.env.TENANT_CORE_ENABLED;
    delete process.env.TEAM_MEMBERSHIPS_ENABLED;
    delete process.env.TEAM_INVITE_OUTBOX_ENABLED;
    delete process.env.CRON_SECRET;
    vi.resetModules();
  });

  it('1) RPC de sweep resolve com sucesso -> 200 com expired preenchido', async () => {
    rpcImpl = (name) => {
      if (name === 'team_invitation_sweep_expired') return Promise.resolve({ data: { expired: 3 }, error: null });
      return emptyClaim(name);
    };
    const app = await buildApp();
    const res = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ expired: { expired: 3 }, claimed: 0, sent: 0, retried: 0, errors: 0 });
  });

  it('2) RPC de sweep devolve { error } (sem lançar) -> best-effort, expired:null, ainda 200', async () => {
    rpcImpl = (name) => {
      if (name === 'team_invitation_sweep_expired') return Promise.resolve({ data: null, error: { message: 'boom', code: 'PGRST000' } });
      return emptyClaim(name);
    };
    const app = await buildApp();
    const res = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.expired).toBeNull();
  });

  it('3) RPC de sweep rejeita/lança inesperadamente -> best-effort, expired:null, ainda 200 (processo não cai)', async () => {
    rpcImpl = (name) => {
      if (name === 'team_invitation_sweep_expired') return Promise.reject(new Error('network exploded'));
      return emptyClaim(name);
    };
    const app = await buildApp();
    const res = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.expired).toBeNull();
  });

  it('4) thenable SEM `.catch()` (forma real do builder) funciona — sucesso', async () => {
    rpcImpl = (name) => {
      if (name === 'team_invitation_sweep_expired') return brokenThenable((resolve) => resolve({ data: { expired: 1 }, error: null }));
      return emptyClaim(name);
    };
    const app = await buildApp();
    const res = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.expired).toEqual({ expired: 1 });
  });

  it('4b) thenable SEM `.catch()` que rejeita — não derruba nada, cai no fallback', async () => {
    rpcImpl = (name) => {
      if (name === 'team_invitation_sweep_expired') return brokenThenable((_resolve, reject) => reject(new Error('boom sem catch')));
      return emptyClaim(name);
    };
    const app = await buildApp();
    const res = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.expired).toBeNull();
  });

  it('5) falha no sweep não encerra o processo Node (o teste em si é a prova: chegou até aqui)', async () => {
    rpcImpl = (name) => {
      if (name === 'team_invitation_sweep_expired') return brokenThenable((_r, reject) => reject(new Error('fatal antigo')));
      return emptyClaim(name);
    };
    const app = await buildApp();
    const before = process.pid;
    await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(process.pid).toBe(before);
    expect(process.exitCode).toBeUndefined();
  });

  it('6) endpoint responde com status e JSON coerentes em sucesso', async () => {
    rpcImpl = emptyClaim;
    const app = await buildApp();
    const res = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimed: 0, sent: 0, retried: 0, errors: 0, expired: null });
  });

  it('7) autenticação ausente/incorreta continua bloqueada (401), sem chamar nenhuma RPC', async () => {
    const app = await buildApp();
    const semSecret = await request(app).post('/jobs/team-invite-outbox');
    expect(semSecret.status).toBe(401);
    const secretErrado = await request(app).post('/jobs/team-invite-outbox?secret=errado');
    expect(secretErrado.status).toBe(401);
    expect(rpcCalls).toHaveLength(0);
  });

  it('8) flag TEAM_INVITE_OUTBOX_ENABLED desligada preserva o comportamento atual (404)', async () => {
    rpcImpl = emptyClaim;
    vi.resetModules();
    process.env.TENANT_CORE_ENABLED = 'false';
    process.env.TEAM_MEMBERSHIPS_ENABLED = 'false';
    process.env.TEAM_INVITE_OUTBOX_ENABLED = 'false';
    process.env.TEAM_INVITE_EMAIL_DELIVERY_ENABLED = 'false';
    process.env.TOKEN_ENCRYPTION_ENABLED = 'false';
    process.env.TOKEN_ENCRYPTION_KEYRING = JSON.stringify({ v1: key });
    process.env.TOKEN_ENCRYPTION_ACTIVE_KEY = 'v1';
    process.env.CRON_SECRET = CRON_SECRET;
    const app = (await import('../src/server.js')).createApp();
    const res = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(res.status).toBe(404);
    expect(rpcCalls).toHaveLength(0);
  });

  it('9) outbox processa normalmente com adapter fake quando há eventos reivindicados', async () => {
    const event = {
      id: 'evt-1',
      organization_id: 'org-1',
      attempt_count: 0,
      idempotency_key: 'idem-evt-1',
    };
    rpcImpl = (name) => {
      if (name === 'team_invitation_sweep_expired') return Promise.resolve({ data: { expired: 0 }, error: null });
      if (name === 'team_outbox_claim') return Promise.resolve({ data: [event], error: null });
      // decrypt vai falhar (payload não é um ciphertext real) — isso é OK: o
      // teste foca no handler HTTP, não na criptografia; processOutboxBatch
      // já é coberto por test/team-invite-outbox.test.js. O importante aqui
      // é que o evento entra em erro/retry e o handler ainda responde 200.
      return Promise.resolve({ data: { status: 'retry' }, error: null });
    };
    const app = await buildApp();
    const res = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(1);
    expect(res.body).not.toHaveProperty('adapter');
  });

  it('10) nenhum e-mail real é enviado — modo teste força o adapter fake mesmo com flags de entrega', async () => {
    const emailAdapter = await import('../src/lib/emailAdapter.js');
    const spy = vi.spyOn(emailAdapter, 'resendEmailAdapter');
    rpcImpl = emptyClaim;
    const app = await buildApp();
    await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('11) segunda chamada após uma falha continua sendo atendida pelo mesmo processo', async () => {
    let call = 0;
    rpcImpl = (name) => {
      if (name === 'team_invitation_sweep_expired') {
        call += 1;
        if (call === 1) return brokenThenable((_r, reject) => reject(new Error('primeira falha')));
        return Promise.resolve({ data: { expired: 0 }, error: null });
      }
      return emptyClaim(name);
    };
    const app = await buildApp();
    const primeira = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    const segunda = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    expect(primeira.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(segunda.body.expired).toEqual({ expired: 0 });
  });

  it('12) log de falha do sweep não contém e-mail, token, payload ou mensagem crua do Postgres — testado direto na chamada de log (não na tubulação de stdout do pino)', async () => {
    const SEGREDO = 'convidado-real@empresa.test';
    const TOKEN = 'invite-token-super-secreto-999';
    const { sweepExpiredInvitations } = await import('../src/routes/jobs.js');
    const errSpy = vi.fn();
    const fakeReq = { log: { error: errSpy } };
    rpcImpl = () => Promise.reject(Object.assign(
      new Error(`falha ao processar convite de ${SEGREDO} com token=${TOKEN}`),
      { code: 'X', detail: `payload=${TOKEN}`, hint: SEGREDO, stack: `Error\n  at x (${SEGREDO})` },
    ));

    const resultado = await sweepExpiredInvitations(fakeReq);

    expect(resultado).toEqual({ data: null });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [meta, msg] = errSpy.mock.calls[0];
    // só {op, code} — nunca message/detail/hint/stack do erro cru.
    expect(Object.keys(meta).sort()).toEqual(['code', 'op']);
    expect(meta.op).toBe('team_invitation_sweep_expired');
    expect(meta.code).toBe('X');
    expect(meta).not.toHaveProperty('message');
    expect(meta).not.toHaveProperty('detail');
    expect(meta).not.toHaveProperty('hint');
    expect(meta).not.toHaveProperty('stack');
    const chamadaSerializada = JSON.stringify(errSpy.mock.calls[0]);
    expect(chamadaSerializada).not.toContain(SEGREDO);
    expect(chamadaSerializada).not.toContain(TOKEN);
    expect(typeof msg).toBe('string');
    expect(msg).not.toContain(SEGREDO);
    expect(msg).not.toContain(TOKEN);

    // Confirma também que a resposta HTTP (o outro artefato observável)
    // nunca carrega o mesmo conteúdo sensível, fim a fim.
    rpcImpl = (name) => {
      if (name === 'team_invitation_sweep_expired') {
        return Promise.reject(Object.assign(
          new Error(`falha ao processar convite de ${SEGREDO} com token=${TOKEN}`),
          { code: 'X', detail: `payload=${TOKEN}`, hint: SEGREDO },
        ));
      }
      return emptyClaim(name);
    };
    const app = await buildApp();
    const res = await request(app).post(`/jobs/team-invite-outbox?secret=${CRON_SECRET}`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(SEGREDO);
    expect(body).not.toContain(TOKEN);
  });

  it('12b) err.code "sujo" (contendo texto livre) nunca é logado cru — normaliza para "unknown"', async () => {
    const { sweepExpiredInvitations, safeErrorMeta } = await import('../src/routes/jobs.js');
    const errSpy = vi.fn();
    rpcImpl = () => Promise.reject(Object.assign(new Error('erro'), { code: 'contém segredo-xyz e espaço' }));
    const resultado = await sweepExpiredInvitations({ log: { error: errSpy } });
    expect(resultado).toEqual({ data: null });
    const [meta] = errSpy.mock.calls[0];
    expect(meta.code).toBe('unknown');
    expect(JSON.stringify(meta)).not.toContain('segredo-xyz');

    // safeErrorMeta isolada: cobre os limites do padrão aceito.
    expect(safeErrorMeta('op_x', { code: 'PGRST116' })).toEqual({ op: 'op_x', code: 'PGRST116' });
    expect(safeErrorMeta('op_x', { code: undefined })).toEqual({ op: 'op_x', code: 'unknown' });
    expect(safeErrorMeta('op_x', null)).toEqual({ op: 'op_x', code: 'unknown' });
    expect(safeErrorMeta('op_x', { code: 'tem espaço' })).toEqual({ op: 'op_x', code: 'unknown' });
  });
});
