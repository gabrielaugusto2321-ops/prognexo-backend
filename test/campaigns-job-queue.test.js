import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
const key = Buffer.alloc(32, 9).toString('base64');
process.env.TOKEN_ENCRYPTION_KEYRING = JSON.stringify({ v1: key });
process.env.TOKEN_ENCRYPTION_ACTIVE_KEY = 'v1';
process.env.JOB_RUNNER_SECRET = 'runner-secret-0123456789';

let db;
const sendWhatsAppMessage = vi.fn(async () => ({}));
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage }));

// Aquece a árvore de imports pesada (googleapis é frio e lento no Windows)
// FORA do timeout de teste — senão o 1º `app()` estoura os 30s.
await import('../src/server.js');

const OWNER = '00000000-0000-4000-b000-000000000001';
const DOC = '00000000-0000-4000-b000-0000000000d1';
const ORG = '00000000-0000-4000-b000-000000000o01';
const CAMP = '00000000-0000-4000-b000-00000000ca01';

function seed(campanhaExtra = {}) {
  db = makeDb({
    users: [{ id: OWNER, role: 'doctor', ativo: true }],
    doctors: [{ id: DOC, owner_user_id: OWNER }],
    integrations: [{ doctor_id: DOC, gateway: 'whatsapp', external_id: 'pn', access_token: 'tok' }],
    campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, status: 'rascunho', mensagem: 'oi', filtro_status: null, ...campanhaExtra }],
    leads: [
      { id: 'L1', doctor_id: DOC, telefone: '5511987654321', telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado', status_atual: 'lead' },
      { id: 'L2', doctor_id: DOC, telefone: '5511987654322', telefone_normalizado: '5511987654322', whatsapp_authorization_status: 'autorizado', status_atual: 'lead' },
    ],
    conversations: [
      { lead_id: 'L1', direcao: 'recebida', timestamp_msg: new Date().toISOString() },
      { lead_id: 'L2', direcao: 'recebida', timestamp_msg: new Date().toISOString() },
    ],
    campanha_envios: [], job_queue: [],
  });
  db.setAuthUser('owner', { id: OWNER });
  sendWhatsAppMessage.mockClear();
}

// mock das RPCs job_enqueue / job_claim / job_retry / job_complete / job_heartbeat
function wireJobRpcs() {
  const orig = db.client.rpc;
  db.client.rpc = vi.fn(async (name, p) => {
    if (name === 'job_enqueue') {
      const existing = db.tables.job_queue.find((j) => j.job_type === p.p_job_type && j.idempotency_key === p.p_idempotency_key && (j.organization_id ?? null) === (p.p_organization_id ?? null));
      if (existing) return { data: existing, error: null };
      const row = { id: p.p_id, organization_id: p.p_organization_id, job_type: p.p_job_type, payload: p.p_payload, idempotency_key: p.p_idempotency_key, status: 'pending', attempts: 0, max_attempts: p.p_max_attempts ?? 5 };
      db.tables.job_queue.push(row);
      return { data: row, error: null };
    }
    if (name === 'job_claim') {
      const claimable = db.tables.job_queue.filter((j) => ['pending', 'retry'].includes(j.status) && p.p_job_types.includes(j.job_type)).slice(0, p.p_batch_size);
      claimable.forEach((j) => { j.status = 'processing'; j.lease_owner = p.p_worker_id; j.attempts += 1; });
      return { data: claimable, error: null };
    }
    if (name === 'job_complete') { const j = db.tables.job_queue.find((x) => x.id === p.p_job_id); if (j) j.status = 'completed'; return { data: j, error: null }; }
    if (name === 'job_heartbeat') { return { data: {}, error: null }; }
    if (name === 'job_retry') {
      const j = db.tables.job_queue.find((x) => x.id === p.p_job_id);
      if (j) { j.status = j.attempts >= j.max_attempts ? 'dead_letter' : 'retry'; j.last_error_code = p.p_error_code; }
      return { data: j, error: null };
    }
    if (name === 'usage_reservations_sweep_stale') return { data: 0, error: null };
    return orig(name, p);
  });
}

async function app({ campaignQueue = 'false', persistentQueue = 'false' } = {}) {
  vi.resetModules();
  process.env.TENANT_CORE_ENABLED = 'false';
  process.env.PERSISTENT_JOB_QUEUE_ENABLED = persistentQueue;
  process.env.USAGE_QUOTAS_ENABLED = 'false';
  process.env.CAMPAIGN_JOB_QUEUE_ENABLED = campaignQueue;
  return (await import('../src/server.js')).createApp();
}

describe('FASE 2.8 — campanha via fila (dispatch persistente)', () => {
  beforeEach(() => seed());

  it('flag off + org: legado (loop destacado), job_queue nunca tocada', async () => {
    const a = await app();
    const res = await request(a).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 120));
    expect(db.tables.job_queue.length).toBe(0);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
  });

  it('flag off + SEM org: legado preservado (cenário 8)', async () => {
    seed({ organization_id: null });
    const a = await app();
    const res = await request(a).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 120));
    expect(db.tables.job_queue.length).toBe(0);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
  });

  it('flag on + org: 202 SÓ depois do campaign.dispatch persistido; resposta traz job_id; nenhum send job na request; sem loop legado (cenários 1, 6)', async () => {
    wireJobRpcs();
    const a = await app({ campaignQueue: 'true', persistentQueue: 'true' });
    const res = await request(a).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    expect(res.body.job_id).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/tok|payload|e1\.v1|prompt|secret|runner-secret/i);
    // no momento da resposta, o dispatch JÁ existe no banco:
    const dispatch = db.tables.job_queue.filter((j) => j.job_type === 'campaign.dispatch');
    expect(dispatch).toHaveLength(1);
    expect(dispatch[0].id).toBe(res.body.job_id);
    // nenhum campaign.send_message foi criado dentro da request:
    expect(db.tables.job_queue.filter((j) => j.job_type === 'campaign.send_message')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('flag on + SEM org: 409 tenant_backfill_required, zero WhatsApp, campanha não vira processando (cenário 7)', async () => {
    seed({ organization_id: null });
    wireJobRpcs();
    const a = await app({ campaignQueue: 'true', persistentQueue: 'true' });
    const res = await request(a).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('tenant_backfill_required');
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    expect(db.tables.job_queue.length).toBe(0);
    expect(db.tables.campanhas.find((c) => c.id === CAMP).status).toBe('rascunho'); // nunca reivindicada
  });

  it('flag on: falha no enqueue do dispatch -> campanha volta a erro, 500 (nenhum 202 prematuro)', async () => {
    wireJobRpcs();
    const orig = db.client.rpc;
    db.client.rpc = vi.fn(async (name, p) => {
      if (name === 'job_enqueue') return { data: null, error: { message: 'db_down' } };
      return orig(name, p);
    });
    const a = await app({ campaignQueue: 'true', persistentQueue: 'true' });
    const res = await request(a).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(500);
    expect(db.tables.campanhas.find((c) => c.id === CAMP).status).toBe('erro');
    expect(db.tables.job_queue.length).toBe(0);
  });

  it('duas requisições simultâneas: uma 202 (com dispatch), outra 409, exatamente um dispatch (cenário 4)', async () => {
    wireJobRpcs();
    const a = await app({ campaignQueue: 'true', persistentQueue: 'true' });
    const [r1, r2] = await Promise.all([
      request(a).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' }),
      request(a).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([202, 409]);
    expect(db.tables.job_queue.filter((j) => j.job_type === 'campaign.dispatch')).toHaveLength(1);
  });
});

describe('FASE 2.8 — worker /jobs/campaign-outbox (auth por header)', () => {
  beforeEach(() => seed());

  it('query string ?secret= é rejeitada (cenário 9)', async () => {
    const a = await app({ campaignQueue: 'true', persistentQueue: 'true' });
    const res = await request(a).post(`/jobs/campaign-outbox?secret=${process.env.JOB_RUNNER_SECRET}`);
    expect(res.status).toBe(401);
  });

  it('header ausente/inválido -> 401 (cenário 10)', async () => {
    const a = await app({ campaignQueue: 'true', persistentQueue: 'true' });
    expect((await request(a).post('/jobs/campaign-outbox')).status).toBe(401);
    expect((await request(a).post('/jobs/campaign-outbox').set({ Authorization: 'Bearer errado' })).status).toBe(401);
    expect((await request(a).post('/jobs/campaign-outbox').set({ 'X-Prognexo-Job-Token': 'errado' })).status).toBe(401);
  });

  it('header válido (Bearer e X-Prognexo-Job-Token) -> worker executa (cenário 11)', async () => {
    wireJobRpcs();
    const a = await app({ campaignQueue: 'true', persistentQueue: 'true' });
    const r1 = await request(a).post('/jobs/campaign-outbox').set({ Authorization: `Bearer ${process.env.JOB_RUNNER_SECRET}` });
    expect(r1.status).toBe(200);
    expect(r1.body).toHaveProperty('claimed');
    const r2 = await request(a).post('/jobs/campaign-outbox').set({ 'X-Prognexo-Job-Token': process.env.JOB_RUNNER_SECRET });
    expect(r2.status).toBe(200);
  });

  it('token nunca aparece na resposta (cenário 12)', async () => {
    wireJobRpcs();
    const a = await app({ campaignQueue: 'true', persistentQueue: 'true' });
    const res = await request(a).post('/jobs/campaign-outbox').set({ Authorization: `Bearer ${process.env.JOB_RUNNER_SECRET}` });
    expect(JSON.stringify(res.body)).not.toContain(process.env.JOB_RUNNER_SECRET);
  });

  it('flags off -> 404 mesmo com header válido', async () => {
    const a = await app({ campaignQueue: 'false', persistentQueue: 'false' });
    expect((await request(a).post('/jobs/campaign-outbox').set({ Authorization: `Bearer ${process.env.JOB_RUNNER_SECRET}` })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('jobRunnerAuth (unit)', async () => {
  const { verifyJobRunnerToken } = await import('../src/lib/jobRunnerAuth.js');
  const withEnv = (v, fn) => { const old = process.env.JOB_RUNNER_SECRET; process.env.JOB_RUNNER_SECRET = v; try { return fn(); } finally { process.env.JOB_RUNNER_SECRET = old; } };

  it('Bearer correto -> true; X-Prognexo-Job-Token correto -> true', () => {
    withEnv('s3cr3t-value-xyz', () => {
      expect(verifyJobRunnerToken({ headers: { authorization: 'Bearer s3cr3t-value-xyz' } })).toBe(true);
      expect(verifyJobRunnerToken({ headers: { 'x-prognexo-job-token': 's3cr3t-value-xyz' } })).toBe(true);
    });
  });
  it('valor errado, tamanho errado, ausente, sem segredo configurado -> false', () => {
    withEnv('s3cr3t-value-xyz', () => {
      expect(verifyJobRunnerToken({ headers: { authorization: 'Bearer errado' } })).toBe(false);
      expect(verifyJobRunnerToken({ headers: { authorization: 'Bearer s3cr3t-value-xyzEXTRA' } })).toBe(false);
      expect(verifyJobRunnerToken({ headers: {} })).toBe(false);
    });
    withEnv(undefined, () => expect(verifyJobRunnerToken({ headers: { authorization: 'Bearer qualquer' } })).toBe(false));
  });
  it('nunca aceita ?secret= (não olha req.query)', () => {
    withEnv('s3cr3t-value-xyz', () => {
      expect(verifyJobRunnerToken({ headers: {}, query: { secret: 's3cr3t-value-xyz' } })).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
describe('handlers de campanha (isolados)', async () => {
  const h = await import('../src/jobs/campaignSendHandler.js');
  const vault = await import('../src/lib/credentialVault.js');
  vault.__setCryptoStateForTests({ TOKEN_ENCRYPTION_ENABLED: 'false', PERSISTENT_JOB_QUEUE_ENABLED: 'true', TOKEN_ENCRYPTION_KEYRING: JSON.stringify({ v1: key }), TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1' });
  const { TokenCipher, buildAad } = vault;

  const enc = (obj, id, sensitive) => {
    const aad = buildAad({ table: 'job_queue', recordId: id, field: 'payload', scope: `org:${ORG}`, provider: 'x' });
    return sensitive ? TokenCipher.encrypt(JSON.stringify(obj), aad) : JSON.stringify(obj);
  };

  // fakeQueue modela a RPC transacional `campaign_recipient_enqueue`:
  // atômica, idempotente por (campanha:lead), respeita estado terminal.
  function fakeQueue(client) {
    const enq = [];
    const recip = []; // { campaignId, leadId }
    const seen = new Set();
    return {
      enq, recip,
      decodePayload: (job, { sensitive }) => JSON.parse(sensitive ? TokenCipher.decrypt(job.payload, buildAad({ table: 'job_queue', recordId: job.id, field: 'payload', scope: `org:${ORG}`, provider: 'x' })) : job.payload),
      enqueue: async (type, payload, opts) => {
        const k = `${type}:${opts?.idempotencyKey}`;
        if (seen.has(k)) return { id: `dup-${k}` };
        seen.add(k); enq.push({ type, payload, opts });
        return { id: `enq-${enq.length}` };
      },
      enqueueCampaignRecipient: async ({ campaignId, leadId }) => {
        const idem = `${campaignId}:${leadId}`;
        const existing = client ? (await client.from('campanha_envios').select('*').eq('campanha_id', campaignId).eq('lead_id', leadId).maybeSingle()).data : null;
        if (existing && existing.status !== 'enviando') {
          return { job_id: seen.has(idem) ? `job-${idem}` : null, ledger_id: existing.id, created: false, terminal: true, envio_status: existing.status };
        }
        let created = false;
        if (!existing && client) { await client.from('campanha_envios').insert({ campanha_id: campaignId, lead_id: leadId, status: 'enviando', job_id: `job-${idem}` }); created = true; }
        if (!seen.has(idem)) { seen.add(idem); recip.push({ campaignId, leadId }); created = true; }
        return { job_id: `job-${idem}`, ledger_id: `le-${idem}`, created, terminal: false };
      },
      complete: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {}),
      retry: vi.fn(async () => ({ status: 'retry' })),
      _seed: (k) => seen.add(k),
    };
  }

  it('dispatch: 1 par (envio+job) por destinatário via RPC atômica; L2 terminal não gera par novo; enfileira finalize; completa; re-run é no-op (cenário 5)', async () => {
    const client = makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, mensagem: 'oi' }],
      leads: [{ id: 'L1', doctor_id: DOC, whatsapp_authorization_status: 'autorizado' }, { id: 'L2', doctor_id: DOC, whatsapp_authorization_status: 'autorizado' }, { id: 'L3', doctor_id: DOC, whatsapp_authorization_status: 'autorizado' }],
      campanha_envios: [{ campanha_id: CAMP, lead_id: 'L2', status: 'enviado' }],
    }).client;
    const q = fakeQueue(client);
    const job = { id: 'disp-1', organization_id: ORG, job_type: 'campaign.dispatch', attempts: 1, idempotency_key: 'dispatch:c:t1', payload: enc({ campaignId: CAMP }, 'disp-1', false) };
    expect(await h.handleCampaignDispatchJob(job, { workerId: 'w', client, queue: q, batchSize: 2 })).toBe(true);
    expect(q.recip.map((r) => r.leadId).sort()).toEqual(['L1', 'L3']); // L2 terminal -> pulado
    expect(q.enq.some((e) => e.type === 'campaign.finalize')).toBe(true);
    expect(q.complete).toHaveBeenCalledWith({ jobId: 'disp-1', workerId: 'w' });
    q.recip.length = 0;
    await h.handleCampaignDispatchJob(job, { workerId: 'w', client, queue: q, batchSize: 2 });
    expect(q.recip).toHaveLength(0); // re-run: nada novo (idempotente)
  });

  it('dispatch: crash no meio -> retry; re-run retoma sem perder nem duplicar (cenário 3)', async () => {
    const client = makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, mensagem: 'oi' }],
      leads: ['L1', 'L2', 'L3', 'L4'].map((id) => ({ id, doctor_id: DOC, whatsapp_authorization_status: 'autorizado' })),
      campanha_envios: [],
    }).client;
    const q = fakeQueue(client);
    const real = q.enqueueCampaignRecipient;
    let n = 0;
    q.enqueueCampaignRecipient = async (a) => { if (++n === 2) throw new Error('boom'); return real(a); };
    const job = { id: 'disp-2', organization_id: ORG, job_type: 'campaign.dispatch', attempts: 1, idempotency_key: 'dispatch:c:t2', payload: enc({ campaignId: CAMP }, 'disp-2', false) };
    expect(await h.handleCampaignDispatchJob(job, { workerId: 'w', client, queue: q, batchSize: 10 })).toBe(false);
    expect(q.retry).toHaveBeenCalled();
    q.enqueueCampaignRecipient = real;
    q.recip.length = 0;
    expect(await h.handleCampaignDispatchJob(job, { workerId: 'w', client, queue: q, batchSize: 10 })).toBe(true);
    const leads = q.recip.map((r) => r.leadId).sort();
    // L1 já criado no r1 (idempotente -> não reaparece); L2,L3,L4 no r2.
    expect(leads).toEqual(['L2', 'L3', 'L4']);
    // campanha_envios: 4 linhas, uma por lead, nenhuma duplicada
    const envios = (await client.from('campanha_envios').select('*').eq('campanha_id', CAMP)).data;
    expect(new Set(envios.map((e) => e.lead_id)).size).toBe(4);
  });

  it('dispatch: campanha SEM destinatários -> enfileira finalize; finalize fecha a campanha vazia', async () => {
    const client = makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, mensagem: 'oi', filtro_status: 'inexistente' }],
      leads: [{ id: 'L1', doctor_id: DOC, status_atual: 'lead', whatsapp_authorization_status: 'autorizado' }],
      campanha_envios: [], job_queue: [],
    }).client;
    const q = fakeQueue(client);
    const disp = { id: 'disp-3', organization_id: ORG, job_type: 'campaign.dispatch', attempts: 1, idempotency_key: 'd:c:t3', payload: enc({ campaignId: CAMP }, 'disp-3', false) };
    await h.handleCampaignDispatchJob(disp, { workerId: 'w', client, queue: q, batchSize: 10 });
    expect(q.enq.filter((e) => e.type === 'campaign.send_message')).toHaveLength(0);
    expect(q.enq.some((e) => e.type === 'campaign.finalize')).toBe(true);
    const fin = { id: 'fin-1', organization_id: ORG, job_type: 'campaign.finalize', attempts: 1, payload: enc({ campaignId: CAMP }, 'fin-1', false) };
    const okFin = await h.handleCampaignFinalizeJob(fin, { workerId: 'w', client, queue: q });
    expect(okFin).toBe(true);
    expect(client.from('campanhas').__ ? true : true);
    const camp = (await client.from('campanhas').select('*').eq('id', CAMP).single()).data;
    expect(camp.status).toBe('concluida');
    expect(camp.enviados).toBe(0);
  });

  it('finalize: ainda tem send em voo -> re-agenda (campaign_not_drained); depois de drenar -> conclui', async () => {
    const client = makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG }],
      campanha_envios: [{ campanha_id: CAMP, lead_id: 'L1', status: 'enviando' }, { campanha_id: CAMP, lead_id: 'L2', status: 'enviado' }],
    }).client;
    const q = fakeQueue(client);
    const fin = { id: 'fin-2', organization_id: ORG, job_type: 'campaign.finalize', attempts: 1, payload: enc({ campaignId: CAMP }, 'fin-2', false) };
    const r1 = await h.handleCampaignFinalizeJob(fin, { workerId: 'w', client, queue: q });
    expect(r1).toBe(false);
    expect(q.retry).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'campaign_not_drained' }));
    // dreou:
    await client.from('campanha_envios').update({ status: 'enviado' }).eq('campanha_id', CAMP).eq('lead_id', 'L1');
    const r2 = await h.handleCampaignFinalizeJob(fin, { workerId: 'w', client, queue: q });
    expect(r2).toBe(true);
    expect((await client.from('campanhas').select('*').eq('id', CAMP).single()).data.status).toBe('concluida');
  });

  it('dispatch/finalize dead_letter -> campanha volta a erro (recuperável, nunca presa) (cenário 14)', async () => {
    const client = makeDb({ campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG }], campanha_envios: [{ campanha_id: CAMP, lead_id: 'L1', status: 'enviando' }] }).client;
    const q = fakeQueue(client);
    q.retry = vi.fn(async () => ({ status: 'dead_letter' }));
    const fin = { id: 'fin-3', organization_id: ORG, job_type: 'campaign.finalize', attempts: 200, payload: enc({ campaignId: CAMP }, 'fin-3', false) };
    await h.handleCampaignFinalizeJob(fin, { workerId: 'w', client, queue: q });
    expect((await client.from('campanhas').select('*').eq('id', CAMP).single()).data.status).toBe('erro');
  });

  function sendFakes(over = {}) {
    const calls = { reserve: [], settle: [], release: [], complete: [], retry: [], send: [] };
    const client = makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, mensagem: 'oi', status: over.campaignStatus || 'processando' }],
      leads: over.noLead ? [] : [{
        id: 'L1', doctor_id: DOC,
        telefone: over.telefoneRaw ?? '5511987654321',
        telefone_normalizado: 'telefoneNormalizado' in over ? over.telefoneNormalizado : '5511987654321',
        whatsapp_authorization_status: over.authorizationStatus || 'autorizado',
        dados_extraidos: over.dadosExtraidos ?? null,
      }],
      conversations: [{ lead_id: 'L1', direcao: 'recebida', timestamp_msg: new Date(over.inboundAgo ?? 0 ? Date.now() - over.inboundAgo : Date.now()).toISOString() }],
      campanha_envios: [{ campanha_id: CAMP, lead_id: 'L1', status: 'enviando' }],
    }).client;
    return {
      client, calls,
      queue: {
        decodePayload: () => ({ campaignId: CAMP, leadId: 'L1', doctorId: DOC }),
        complete: async (a) => { calls.complete.push(a); },
        retry: async (a) => { calls.retry.push(a); return over.retryResult ?? { status: 'retry' }; },
      },
      quota: {
        reserve: async (a) => {
          calls.reserve.push(a);
          if (over.statusAfterReserve) {
            await client.from('leads').update({ whatsapp_authorization_status: over.statusAfterReserve }).eq('id', 'L1');
          }
          return over.reserve ?? { allowed: true, reservationId: 'rv-1' };
        },
        settle: async (a) => { calls.settle.push(a); },
        release: async (a) => { calls.release.push(a); },
      },
      send: async (...a) => { calls.send.push(a); if (over.sendThrows) throw Object.assign(new Error('meta_down'), { code: 'meta_down' }); },
      credentialVault: {
        resolveWhatsAppSendCredentials: async () => (
          over.credentials ?? { externalId: 'pn', accessToken: 'tok' }
        ),
      },
    };
  }
  const sendJob = (attempts = 0) => ({ id: 'snd', organization_id: ORG, job_type: 'campaign.send_message', attempts, payload: enc({ campaignId: CAMP, leadId: 'L1', doctorId: DOC }, 'snd', true) });

  it('send happy path: reserve -> send -> settle -> complete, campanha_envios enviado', async () => {
    const f = sendFakes();
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(true);
    expect(f.calls.reserve).toHaveLength(1); expect(f.calls.send).toHaveLength(1);
    expect(f.calls.settle).toHaveLength(1); expect(f.calls.release).toHaveLength(0);
  });
  it('send quota negada: nunca chama send, retry, sem settle/release (cenário 13)', async () => {
    const f = sendFakes({ reserve: { allowed: false, reservationId: null } });
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(false);
    expect(f.calls.send).toHaveLength(0); expect(f.calls.settle).toHaveLength(0); expect(f.calls.release).toHaveLength(0);
    expect(f.calls.retry[0].errorCode).toBe('quota_denied');
  });
  it('send falha depois da reserva: NÃO libera (msg pode ter saído), retry (cenário 13)', async () => {
    const f = sendFakes({ sendThrows: true });
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(false);
    expect(f.calls.release).toHaveLength(0); expect(f.calls.retry[0].errorCode).toBe('meta_down');
  });
  it('send dead_letter: campanha_envios -> falhou', async () => {
    const f = sendFakes({ sendThrows: true, retryResult: { status: 'dead_letter' } });
    await h.handleCampaignSendJob(sendJob(5), { workerId: 'w', ...f });
    expect((await f.client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data.status).toBe('falhou');
  });
  it('send: lead removido entre dispatch e send -> falhou, completa, sem send (review)', async () => {
    const f = sendFakes({ noLead: true });
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(true);
    expect(f.calls.send).toHaveLength(0); expect(f.calls.reserve).toHaveLength(0);
    expect((await f.client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data.status).toBe('falhou');
  });
  it('send: campanha cancelada entre dispatch e send -> falhou, completa, sem send (review)', async () => {
    const f = sendFakes({ campaignStatus: 'cancelada' });
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(true);
    expect(f.calls.send).toHaveLength(0);
  });
  it('send: fora da janela 24h -> pendente_template, completa, sem quota nem send', async () => {
    const f = sendFakes({ inboundAgo: 48 * 3600_000 });
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(true);
    expect(f.calls.reserve).toHaveLength(0); expect(f.calls.send).toHaveLength(0);
    expect((await f.client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data.status).toBe('pendente_template');
  });
  it.each([
    ['pendente', 'sem_autorizacao'], ['recusado', 'sem_autorizacao'], ['opt_out', 'opt_out'],
  ])('send bloqueia consentimento %s', async (authorizationStatus, expected) => {
    const f = sendFakes({ authorizationStatus });
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(true);
    expect(f.calls.send).toHaveLength(0);
    expect((await f.client.from('campanha_envios').select('*').eq('lead_id', 'L1').single()).data.status).toBe(expected);
  });
  it('send usa o telefone canônico E.164 (telefone_normalizado), nunca o campo bruto', async () => {
    const f = sendFakes({ telefoneRaw: 'lixo-nao-deveria-ser-usado', telefoneNormalizado: '5511987654321' });
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(true);
    expect(f.calls.send).toHaveLength(1);
    expect(f.calls.send[0][2]).toBe('5511987654321');
  });
  it('sem telefone_normalizado: cai para normalizar leads.telefone (formato legado sem o nono dígito) de forma determinística', async () => {
    const f = sendFakes({ telefoneNormalizado: null, telefoneRaw: '554396216864' }); // 12 dígitos, sem o 9
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(true);
    expect(f.calls.send).toHaveLength(1);
    expect(f.calls.send[0][2]).toBe('5543996216864'); // canônico com o 9 inserido
  });
  it('telefone inválido/ambíguo (sem telefone_normalizado e telefone bruto não determinístico) bloqueia ANTES da Meta com invalid_recipient_phone', async () => {
    const f = sendFakes({ telefoneNormalizado: null, telefoneRaw: 'nao-e-um-telefone' });
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(true);
    expect(f.calls.send).toHaveLength(0); // Meta NUNCA é chamada
    expect((await f.client.from('campanha_envios').select('*').eq('lead_id', 'L1').single()).data.status).toBe('invalid_recipient_phone');
  });
  it('lead em quarentena de identidade (phone_identity_review_required) bloqueia ANTES da Meta, mesmo com telefone_normalizado presente', async () => {
    const f = sendFakes({
      telefoneNormalizado: '5511987654321', // canônico até existiria, mas a quarentena bloqueia mesmo assim
      dadosExtraidos: { phone_identity_review_required: true, phone_identity_reason: 'ambiguous_candidates' },
    });
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(true);
    expect(f.calls.send).toHaveLength(0);
    expect((await f.client.from('campanha_envios').select('*').eq('lead_id', 'L1').single()).data.status).toBe('phone_identity_review_required');
  });
  it('re-check imediatamente antes do send bloqueia opt-out ocorrido no meio do job', async () => {
    const f = sendFakes({ statusAfterReserve: 'opt_out' });
    expect(await h.handleCampaignSendJob(sendJob(), { workerId: 'w', ...f })).toBe(true);
    expect(f.calls.send).toHaveLength(0);
    expect(f.calls.release).toHaveLength(1);
    expect((await f.client.from('campanha_envios').select('*').eq('lead_id', 'L1').single()).data.status).toBe('opt_out');
  });
});
