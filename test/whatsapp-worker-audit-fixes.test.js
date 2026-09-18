// Auditoria final FASE 2 — testes direcionados pros gaps encontrados e
// corrigidos:
// (1) revalidação do template imediatamente antes da Meta usa leitura
//     fresca (não um snapshot capturado antes da reserva de quota);
// (2) idempotência de estado terminal contra reprocessamento do MESMO job;
// (3) resposta 2xx com corpo ilegível é tratada como resultado ambíguo,
//     nunca cai em retry automático;
// (4) limite de destinatários é tudo-ou-nada: excede -> aborta a operação
//     INTEIRA (nunca enfileira/envia ninguém), nunca trunca parcialmente;
// (5) trava atômica (compare-and-swap) do ledger imediatamente antes da
//     chamada HTTP — fecha a janela entre a Meta aceitar e o banco registrar
//     o sucesso; concorrência real (Promise.all) e recuperação de "enviando"
//     abandonado (lease expirada/restart) nunca disparam a Meta de novo.
import { describe, it, expect, vi } from 'vitest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
vi.mock('../src/lib/supabase.js', () => ({ supabase: {} }));

const DOC = '00000000-0000-4000-9200-0000000000d1';
const ORG = '00000000-0000-4000-9200-000000000o01';
const CAMP = '00000000-0000-4000-9200-00000000ca01';
const TPL = '00000000-0000-4000-9200-0000000tp01';

function baseTemplate(overrides = {}) {
  return {
    id: TPL, doctor_id: DOC, meta_template_id: 'mt-1', nome: 'confirmacao', idioma: 'pt_BR',
    status: 'APPROVED', body_text: 'Olá {{1}}', body_variable_count: 1,
    supported: true, active: true, last_synced_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeQueue(over = {}) {
  return {
    decodePayload: () => ({ campaignId: CAMP, leadId: 'L1', doctorId: DOC }),
    complete: vi.fn(async () => {}),
    retry: vi.fn(async () => over.retryResult ?? { status: 'retry' }),
  };
}
function fakeQuota(over = {}) {
  const calls = { reserve: [], settle: [], release: [] };
  return {
    calls,
    reserve: async (a) => { calls.reserve.push(a); if (over.onReserve) await over.onReserve(); return over.reserve ?? { allowed: true, reservationId: 'rv-1' }; },
    settle: async (a) => { calls.settle.push(a); },
    release: async (a) => { calls.release.push(a); },
  };
}
const fakeVault = { resolveWhatsAppSendCredentials: async () => ({ externalId: 'pn', accessToken: 'tok' }) };

describe('worker — revalidação do template imediatamente antes da Meta (leitura fresca, não snapshot)', async () => {
  const { handleCampaignSendJob } = await import('../src/jobs/campaignSendHandler.js');

  function seed() {
    return makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, status: 'processando', modo_envio: 'template', whatsapp_template_id: TPL, template_variable_map: { 1: { source: 'lead_nome' } } }],
      leads: [{ id: 'L1', doctor_id: DOC, nome: 'Maria', telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado' }],
      whatsapp_templates: [baseTemplate()],
      campanha_envios: [{ campanha_id: CAMP, lead_id: 'L1', status: 'enviando' }],
    }).client;
  }
  const job = { id: 'snd-1', organization_id: ORG, job_type: 'campaign.send_message' };

  it('template revogado ENTRE a checagem inicial e a reserva de quota é pego pela releitura antes do envio', async () => {
    const client = seed();
    const sendTemplate = vi.fn(async () => ({ messageId: 'wamid.mock' }));
    const quota = fakeQuota({
      onReserve: () => client.from('whatsapp_templates').update({ active: false }).eq('id', TPL),
    });
    const queue = fakeQueue();
    const ok = await handleCampaignSendJob(job, { workerId: 'w', client, queue, quota, sendTemplate, credentialVault: fakeVault });
    expect(ok).toBe(true);
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(quota.calls.release).toHaveLength(1);
    const envio = (await client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data;
    expect(envio.status).toBe('template_indisponivel');
  });

  it('template ainda válido no momento real do envio: usa os dados mais recentes (não o snapshot antigo) nos parâmetros', async () => {
    const client = seed();
    const sendTemplate = vi.fn(async () => ({ messageId: 'wamid.mock' }));
    const quota = fakeQuota({
      onReserve: () => client.from('whatsapp_templates').update({ nome: 'confirmacao_v2', idioma: 'en_US' }).eq('id', TPL),
    });
    const queue = fakeQueue();
    const ok = await handleCampaignSendJob(job, { workerId: 'w', client, queue, quota, sendTemplate, credentialVault: fakeVault });
    expect(ok).toBe(true);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][3]).toMatchObject({ name: 'confirmacao_v2', languageCode: 'en_US' });
  });
});

describe('worker — idempotência de estado terminal contra reprocessamento do mesmo job', async () => {
  const { handleCampaignSendJob } = await import('../src/jobs/campaignSendHandler.js');

  function seed(envioStatus) {
    return makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, status: 'processando', mensagem: 'oi', modo_envio: 'texto_livre' }],
      leads: [{ id: 'L1', doctor_id: DOC, nome: 'Maria', telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado' }],
      conversations: [{ lead_id: 'L1', direcao: 'recebida', timestamp_msg: new Date().toISOString() }],
      campanha_envios: [{ campanha_id: CAMP, lead_id: 'L1', status: envioStatus }],
    }).client;
  }
  const job = { id: 'snd-2', organization_id: ORG, job_type: 'campaign.send_message' };

  it.each(['enviado', 'falhou', 'resultado_desconhecido', 'opt_out'])(
    'reclaim de um job já resolvido (%s) nunca chama a Meta de novo — só completa',
    async (status) => {
      const client = seed(status);
      const send = vi.fn(async () => ({}));
      const queue = fakeQueue();
      const quota = fakeQuota();
      const ok = await handleCampaignSendJob(job, { workerId: 'w', client, queue, quota, send, credentialVault: fakeVault });
      expect(ok).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect(quota.calls.reserve).toHaveLength(0);
      expect(queue.complete).toHaveBeenCalledTimes(1);
      expect((await client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data.status).toBe(status);
    }
  );

  it('job ainda em "enviando" (nunca processado) segue o fluxo normal, chama a Meta', async () => {
    const client = seed('enviando');
    const send = vi.fn(async () => ({}));
    const queue = fakeQueue();
    const quota = fakeQuota();
    const ok = await handleCampaignSendJob(job, { workerId: 'w', client, queue, quota, send, credentialVault: fakeVault });
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('worker — trava atômica (compare-and-swap) imediatamente antes da chamada HTTP', async () => {
  const { handleCampaignSendJob } = await import('../src/jobs/campaignSendHandler.js');

  function seed(envioExtra = {}) {
    return makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, status: 'processando', mensagem: 'oi', modo_envio: 'texto_livre' }],
      leads: [{ id: 'L1', doctor_id: DOC, nome: 'Maria', telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado' }],
      conversations: [{ lead_id: 'L1', direcao: 'recebida', timestamp_msg: new Date().toISOString() }],
      campanha_envios: [{ campanha_id: CAMP, lead_id: 'L1', status: 'enviando', ...envioExtra }],
    }).client;
  }
  const job = () => ({ id: 'snd-3', organization_id: ORG, job_type: 'campaign.send_message' });

  it('CONCORRÊNCIA: duas execuções simultâneas do MESMO job (Promise.all) — só uma chama a Meta', async () => {
    const client = seed();
    const send = vi.fn(async () => ({}));
    const queue1 = fakeQueue();
    const queue2 = fakeQueue();
    const quota = fakeQuota();
    const [ok1, ok2] = await Promise.all([
      handleCampaignSendJob(job(), { workerId: 'w1', client, queue: queue1, quota, send, credentialVault: fakeVault }),
      handleCampaignSendJob(job(), { workerId: 'w2', client, queue: queue2, quota, send, credentialVault: fakeVault }),
    ]);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    expect(send).toHaveBeenCalledTimes(1); // nunca duas vezes, mesmo com as duas execuções em paralelo
    const envio = (await client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data;
    // um dos dois vence e envia ('enviado'); o outro perde a corrida e nunca
    // chega a chamar a Meta — sem sobrescrever o resultado do vencedor.
    expect(envio.status).toBe('enviado');
  });

  it('TRAVA RECENTE: dentro de WHATSAPP_SEND_LOCK_STALE_MS nunca chama a Meta E nunca altera campanha_envios (não confunde concorrente ativo com abandonado)', async () => {
    const lockAt = new Date(Date.now() - 2_000).toISOString(); // 2s atrás — bem dentro do timeout HTTP da Meta
    const client = seed({ envio_iniciado_em: lockAt });
    const send = vi.fn(async () => ({}));
    const queue = fakeQueue();
    const quota = fakeQuota();
    const ok = await handleCampaignSendJob(job(), { workerId: 'w', client, queue, quota, send, credentialVault: fakeVault });
    expect(ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(queue.retry).not.toHaveBeenCalled();
    expect(queue.complete).toHaveBeenCalledTimes(1);
    // nunca escreveu nada — nem status, nem envio_iniciado_em — deixa pro
    // dono real da trava resolver (nunca sobrescreve o resultado dele).
    const envio = (await client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data;
    expect(envio.status).toBe('enviando');
    expect(envio.envio_iniciado_em).toBe(lockAt);
  });

  it('RECUPERAÇÃO: "enviando" abandonado (trava mais velha que WHATSAPP_SEND_LOCK_STALE_MS) vira resultado_desconhecido, nunca chama a Meta, nunca faz retry', async () => {
    const client = seed({ envio_iniciado_em: new Date(Date.now() - 600_000).toISOString() }); // 10min atrás — bem além do teto (default 60s)
    const send = vi.fn(async () => ({}));
    const queue = fakeQueue();
    const quota = fakeQuota();
    const ok = await handleCampaignSendJob(job(), { workerId: 'w', client, queue, quota, send, credentialVault: fakeVault });
    expect(ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(queue.retry).not.toHaveBeenCalled();
    expect(queue.complete).toHaveBeenCalledTimes(1);
    const envio = (await client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data;
    expect(envio.status).toBe('resultado_desconhecido');
  });

  it('rejeição confirmada (retriable) libera a trava para a PRÓXIMA tentativa legítima conseguir enviar', async () => {
    const client = seed();
    let attempt = 0;
    const send = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' }); // rejeição confirmada, sem networkError/metaError ambíguo
      return {};
    });
    const queue = fakeQueue({ retryResult: { status: 'retry' } });
    const quota = fakeQuota();

    const ok1 = await handleCampaignSendJob(job(), { workerId: 'w', client, queue, quota, send, credentialVault: fakeVault });
    expect(ok1).toBe(false); // vai tentar de novo
    expect(queue.retry).toHaveBeenCalledTimes(1);
    let envio = (await client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data;
    expect(envio.status).toBe('enviando'); // ainda em aberto — retry, não falhou
    expect(envio.envio_iniciado_em).toBeFalsy(); // trava liberada pra próxima tentativa

    const ok2 = await handleCampaignSendJob(job(), { workerId: 'w', client, queue, quota, send, credentialVault: fakeVault });
    expect(ok2).toBe(true);
    expect(send).toHaveBeenCalledTimes(2); // a segunda tentativa realmente chamou a Meta de novo
    envio = (await client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data;
    expect(envio.status).toBe('enviado');
  });

  it('dead_letter (esgotou tentativas): trava NUNCA é liberada às cegas, mas o status vira falhou (terminal, nunca reenviado)', async () => {
    const client = seed();
    const send = vi.fn(async () => { throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' }); });
    const queue = fakeQueue({ retryResult: { status: 'dead_letter' } });
    const quota = fakeQuota();
    const ok = await handleCampaignSendJob(job(), { workerId: 'w', client, queue, quota, send, credentialVault: fakeVault });
    expect(ok).toBe(false);
    const envio = (await client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data;
    expect(envio.status).toBe('falhou');
  });
});

describe('worker — WHATSAPP_SEND_LOCK_STALE_MS é configurável (não um número mágico fixo)', () => {
  const originalStale = process.env.WHATSAPP_SEND_LOCK_STALE_MS;

  function seed(envioExtra = {}) {
    return makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, status: 'processando', mensagem: 'oi', modo_envio: 'texto_livre' }],
      leads: [{ id: 'L1', doctor_id: DOC, nome: 'Maria', telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado' }],
      conversations: [{ lead_id: 'L1', direcao: 'recebida', timestamp_msg: new Date().toISOString() }],
      campanha_envios: [{ campanha_id: CAMP, lead_id: 'L1', status: 'enviando', ...envioExtra }],
    }).client;
  }

  it('teto customizado (5s): trava de 3s ainda é tratada como ativa (no-op)', async () => {
    process.env.WHATSAPP_SEND_LOCK_STALE_MS = '5000';
    vi.resetModules();
    const { handleCampaignSendJob: handle } = await import('../src/jobs/campaignSendHandler.js');
    const client = seed({ envio_iniciado_em: new Date(Date.now() - 3_000).toISOString() });
    const send = vi.fn(async () => ({}));
    const queue = fakeQueue();
    const quota = fakeQuota();
    const ok = await handle({ id: 'snd-cfg-1', organization_id: ORG, job_type: 'campaign.send_message' }, { workerId: 'w', client, queue, quota, send, credentialVault: fakeVault });
    expect(ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect((await client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data.status).toBe('enviando');
  });

  it('teto customizado (5s): trava de 8s já é abandonada -> resultado_desconhecido', async () => {
    process.env.WHATSAPP_SEND_LOCK_STALE_MS = '5000';
    vi.resetModules();
    const { handleCampaignSendJob: handle } = await import('../src/jobs/campaignSendHandler.js');
    const client = seed({ envio_iniciado_em: new Date(Date.now() - 8_000).toISOString() });
    const send = vi.fn(async () => ({}));
    const queue = fakeQueue();
    const quota = fakeQuota();
    const ok = await handle({ id: 'snd-cfg-2', organization_id: ORG, job_type: 'campaign.send_message' }, { workerId: 'w', client, queue, quota, send, credentialVault: fakeVault });
    expect(ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect((await client.from('campanha_envios').select('*').eq('lead_id', 'L1').maybeSingle()).data.status).toBe('resultado_desconhecido');
  });

  it('restaura env', () => {
    if (originalStale === undefined) delete process.env.WHATSAPP_SEND_LOCK_STALE_MS;
    else process.env.WHATSAPP_SEND_LOCK_STALE_MS = originalStale;
  });
});

describe('sendWhatsAppTemplate — resposta ambígua (2xx com corpo ilegível) nunca é tratada como retriable', async () => {
  const { sendWhatsAppTemplate } = await import('../src/lib/whatsapp.js');

  it('HTTP 200 mas resp.json() falha -> networkError (mesmo caminho do timeout, sem retry automático)', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('unexpected end of json'); } }));
    try {
      await expect(sendWhatsAppTemplate('pn', 'tok', '5511987654321', { name: 't', languageCode: 'pt_BR', bodyParameters: [] }))
        .rejects.toMatchObject({ networkError: true });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('HTTP 4xx/5xx com corpo ilegível ainda é rejeição confirmada (nunca networkError, elegível pro retry padrão)', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => { throw new SyntaxError('bad gateway html'); } }));
    try {
      const err = await sendWhatsAppTemplate('pn', 'tok', '5511987654321', { name: 't', languageCode: 'pt_BR', bodyParameters: [] }).catch((e) => e);
      expect(err.networkError).toBeFalsy();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('sucesso normal (2xx com corpo válido) continua funcionando', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.ok' }] }) }));
    try {
      const { messageId } = await sendWhatsAppTemplate('pn', 'tok', '5511987654321', { name: 't', languageCode: 'pt_BR', bodyParameters: [] });
      expect(messageId).toBe('wamid.ok');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('worker — limite de destinatários é tudo-ou-nada (nunca truncamento parcial)', () => {
  const originalCap = process.env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS;

  function fakeDispatchQueue() {
    const enq = [];
    return {
      decodePayload: () => ({ campaignId: CAMP }),
      enqueueCampaignRecipient: async ({ leadId }) => { enq.push(leadId); return { created: true }; },
      enqueue: vi.fn(async () => ({ id: 'finalize-1' })),
      complete: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {}),
      retry: vi.fn(async () => ({ status: 'retry' })),
      enq,
    };
  }

  it('dispatch: mais elegíveis do que o teto -> ABORTA por completo (zero jobs enfileirados), campanha vai pra erro', async () => {
    process.env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS = '2';
    vi.resetModules();
    const { handleCampaignDispatchJob: handle } = await import('../src/jobs/campaignSendHandler.js');
    const client = makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, mensagem: 'oi', status: 'processando' }],
      leads: ['L1', 'L2', 'L3'].map((id) => ({ id, doctor_id: DOC, whatsapp_authorization_status: 'autorizado' })),
      campanha_envios: [],
    }).client;
    const queue = fakeDispatchQueue();
    const log = { error: vi.fn(), warn: vi.fn() };
    const job = { id: 'disp-cap-1', organization_id: ORG, job_type: 'campaign.dispatch' };
    await handle(job, { workerId: 'w', client, queue, log, batchSize: 10 });
    expect(queue.enq).toHaveLength(0); // NENHUM destinatário enfileirado — nunca um subconjunto parcial
    expect(queue.enqueue).not.toHaveBeenCalledWith('campaign.finalize', expect.anything(), expect.anything());
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'campaign_recipient_limit_exceeded', eligibleCount: 3, maxRecipients: 2 }),
      expect.any(String)
    );
    expect((await client.from('campanhas').select('*').eq('id', CAMP).single()).data.status).toBe('erro');
  });

  it('dispatch: leads dentro do teto -> enfileira todos normalmente', async () => {
    process.env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS = '10';
    vi.resetModules();
    const { handleCampaignDispatchJob: handle } = await import('../src/jobs/campaignSendHandler.js');
    const client = makeDb({
      campanhas: [{ id: CAMP, doctor_id: DOC, organization_id: ORG, mensagem: 'oi', status: 'processando' }],
      leads: ['L1', 'L2'].map((id) => ({ id, doctor_id: DOC, whatsapp_authorization_status: 'autorizado' })),
      campanha_envios: [],
    }).client;
    const queue = fakeDispatchQueue();
    const log = { error: vi.fn(), warn: vi.fn() };
    const job = { id: 'disp-cap-2', organization_id: ORG, job_type: 'campaign.dispatch' };
    await handle(job, { workerId: 'w', client, queue, log, batchSize: 10 });
    expect(queue.enq.sort()).toEqual(['L1', 'L2']);
    expect(log.error).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'campaign_recipient_limit_exceeded' }), expect.any(String));
  });

  it('restaura env', () => {
    if (originalCap === undefined) delete process.env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS;
    else process.env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS = originalCap;
  });
});
