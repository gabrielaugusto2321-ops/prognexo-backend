import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
process.env.META_APP_SECRET = 'test-app-secret';
process.env.WHATSAPP_WEBHOOK_SIGNATURE_ENFORCED = 'true';

let db;
const processarMensagemComIA = vi.fn(async () => ({
  resposta: 'oi',
  status: 'qualificando',
  score: 10,
  motivoHandoff: null,
  semResposta: false,
  dados_extraidos: null,
}));
const sendWhatsAppMessage = vi.fn(async () => ({}));

vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));
vi.mock('../src/lib/iaAgent.js', () => ({ processarMensagemComIA }));
vi.mock('../src/lib/knowledgeChunks.js', () => ({ buscarChunksRelevantes: vi.fn(async () => []) }));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage, sendWhatsAppTemplate: vi.fn(async () => ({ messageId: 'wamid.mock' })) }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));

const { app } = await import('../src/server.js');

function payload(messageId = 'wamid.1', body = 'oi') {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts: [{ wa_id: '5511999', profile: { name: 'Lead' } }],
              messages: [{ id: messageId, from: '5511999', type: 'text', text: { body }, timestamp: '1700000000' }],
            },
          },
        ],
      },
    ],
  };
}

// Payload com phone_number_id / from / wa_id configuráveis, pros testes de
// identidade de telefone (wa_id exato, formato legado, ambiguidade, cross-doctor).
function payloadIdentidade({ phoneNumberId = 'pn-1', from, waId = from, messageId = 'wamid.id-1', body = 'oi' }) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              contacts: [{ wa_id: waId, profile: { name: 'Lead' } }],
              messages: [{ id: messageId, from, type: 'text', text: { body }, timestamp: '1700000000' }],
            },
          },
        ],
      },
    ],
  };
}

function sign(raw) {
  return 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
}

beforeEach(() => {
  processarMensagemComIA.mockClear();
  sendWhatsAppMessage.mockClear();
  db = makeDb({
    integrations: [
      { doctor_id: 'D', gateway: 'whatsapp', external_id: 'pn-1', access_token: 'tok' },
      { doctor_id: 'D2', gateway: 'whatsapp', external_id: 'pn-2', access_token: 'tok2' },
    ],
    doctors: [
      { id: 'D', ia_atendimento_ativo: true, ia_limite_mensagens: 20 },
      { id: 'D2', ia_atendimento_ativo: true, ia_limite_mensagens: 20 },
    ],
    leads: [],
    conversations: [],
    deals: [],
    webhook_events: [],
  });
});

describe('POST /webhooks/whatsapp (comportamental)', () => {
  it('assinatura ausente → 403', async () => {
    const res = await request(app).post('/webhooks/whatsapp').send(payload());
    expect(res.status).toBe(403);
    expect(processarMensagemComIA).not.toHaveBeenCalled();
  });

  it('assinatura inválida → 403', async () => {
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload()));
    expect(res.status).toBe(403);
    expect(processarMensagemComIA).not.toHaveBeenCalled();
  });

  it('assinatura válida → 200 e processa a mensagem', async () => {
    const raw = JSON.stringify(payload('wamid.A'));
    const res = await request(app)
      .post('/webhooks/whatsapp')
      .set('X-Hub-Signature-256', sign(raw))
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); // processamento assíncrono
    expect(processarMensagemComIA).toHaveBeenCalledTimes(1);
    expect(db.tables.webhook_events).toHaveLength(1);
  });

  it('replay do mesmo message.id → IA não é chamada de novo', async () => {
    const raw = JSON.stringify(payload('wamid.R'));
    const sig = sign(raw);
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sig).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 50));
    processarMensagemComIA.mockClear();
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sig).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 50));
    expect(processarMensagemComIA).not.toHaveBeenCalled();
    expect(db.tables.webhook_events).toHaveLength(1);
  });

  it.each(['PARAR', ' sair ', 'stop', 'CANCELÁR'])('opt-out exato %s persiste e pula IA', async (word) => {
    const raw = JSON.stringify(payload(`wamid.${word}`, word));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw)).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 50));
    expect(db.tables.leads[0].whatsapp_authorization_status).toBe('opt_out');
    expect(db.tables.leads[0].whatsapp_authorization_source).toBe('whatsapp_message');
    expect(processarMensagemComIA).not.toHaveBeenCalled();
    expect(db.tables.conversations.some((c) => c.direcao === 'recebida')).toBe(true);
  });

  it('não aceita PARAR como substring', async () => {
    const raw = JSON.stringify(payload('wamid.substring', 'quero parar depois'));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw)).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 50));
    expect(db.tables.leads[0].whatsapp_authorization_status).not.toBe('opt_out');
    expect(processarMensagemComIA).toHaveBeenCalledTimes(1);
  });

  // Correção 2 da FASE 1 — opt-out precisa ser durável para o lead, não só
  // para a mensagem de opt-out em si: uma mensagem comum POSTERIOR também não
  // pode disparar IA, mas continua chegando normalmente para atendimento
  // humano (fica gravada em conversations).
  it('opt-out é durável: PARAR e depois uma mensagem comum — nenhuma das duas chama a IA; a segunda fica visível para humano', async () => {
    const raw1 = JSON.stringify(payload('wamid.durable-1', 'PARAR'));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw1)).set('Content-Type', 'application/json').send(raw1);
    await new Promise((r) => setTimeout(r, 50));
    expect(db.tables.leads[0].whatsapp_authorization_status).toBe('opt_out');
    expect(processarMensagemComIA).not.toHaveBeenCalled();

    const raw2 = JSON.stringify(payload('wamid.durable-2', 'oi, mudei de ideia'));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw2)).set('Content-Type', 'application/json').send(raw2);
    await new Promise((r) => setTimeout(r, 50));

    // continua opt_out — mensagem comum nunca reverte
    expect(db.tables.leads[0].whatsapp_authorization_status).toBe('opt_out');
    // IA continua bloqueada na segunda mensagem também
    expect(processarMensagemComIA).not.toHaveBeenCalled();
    // mas a segunda mensagem apareceu normalmente pra atendimento humano
    const recebidas = db.tables.conversations.filter((c) => c.direcao === 'recebida');
    expect(recebidas).toHaveLength(2);
    expect(recebidas[1].conteudo).toBe('oi, mudei de ideia');
  });
});

describe('POST /webhooks/whatsapp — identidade de telefone (v2)', () => {
  it('wa_id exato encontra o mesmo lead — não cria duplicado', async () => {
    db.tables.leads.push({ id: 'lead-1', doctor_id: 'D', telefone: '43996216864', telefone_normalizado: null, whatsapp_wa_id: '5543996216864', status_atual: 'lead', atendido_por: null });
    const raw = JSON.stringify(payloadIdentidade({ from: '5543996216864', messageId: 'wamid.waid-1' }));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw)).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 700));
    expect(db.tables.leads).toHaveLength(1);
    expect(db.tables.conversations.find((c) => c.direcao === 'recebida')?.lead_id).toBe('lead-1');
  });

  it('formato legado (12 dígitos, sem o nono) resolve pro canônico já existente — não cria duplicado e faz backfill do wa_id', async () => {
    db.tables.leads.push({ id: 'lead-2', doctor_id: 'D', telefone: '43996216864', telefone_normalizado: '5543996216864', whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null });
    const raw = JSON.stringify(payloadIdentidade({ from: '554396216864', messageId: 'wamid.legacy-1' })); // 12 dígitos, sem o 9
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw)).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 700));
    expect(db.tables.leads).toHaveLength(1);
    expect(db.tables.leads[0].whatsapp_wa_id).toBe('554396216864');
  });

  it('sem lead existente: cria um novo preservando telefone original, wa_id bruto e canonical de 13 dígitos', async () => {
    const raw = JSON.stringify(payloadIdentidade({ from: '554396216864', messageId: 'wamid.new-legacy' }));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw)).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 700));
    expect(db.tables.leads).toHaveLength(1);
    const lead = db.tables.leads[0];
    expect(lead.telefone).toBe('554396216864'); // original preservado, sem inserir o 9 no campo bruto
    expect(lead.whatsapp_wa_id).toBe('554396216864');
    expect(lead.telefone_normalizado).toBe('5543996216864'); // canônico com o 9, determinístico
  });

  it('ambiguidade entre dois leads legados do mesmo médico não une silenciosamente — cria lead de QUARENTENA e preserva a conversa (nunca descarta a mensagem)', async () => {
    db.tables.leads.push(
      { id: 'lead-amb-1', doctor_id: 'D', telefone: '554396216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
      { id: 'lead-amb-2', doctor_id: 'D', telefone: '43996216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
    );
    const raw = JSON.stringify(payloadIdentidade({ from: '554396216864', messageId: 'wamid.ambiguous-1' }));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw)).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 700));
    expect(db.tables.leads).toHaveLength(3); // os 2 originais + 1 lead de quarentena novo
    const quarentena = db.tables.leads.find((l) => !['lead-amb-1', 'lead-amb-2'].includes(l.id));
    expect(quarentena.whatsapp_wa_id).toBe('554396216864');
    expect(quarentena.telefone_normalizado).toBeNull();
    expect(quarentena.whatsapp_authorization_status).toBe('pendente');
    expect(quarentena.dados_extraidos).toMatchObject({ phone_identity_review_required: true, phone_identity_reason: 'ambiguous_candidates' });
    // a conversa É gravada — nunca perdida — só que no lead de quarentena
    const recebida = db.tables.conversations.find((c) => c.direcao === 'recebida');
    expect(recebida).toBeTruthy();
    expect(recebida.lead_id).toBe(quarentena.id);
    expect(processarMensagemComIA).not.toHaveBeenCalled(); // IA nunca responde a lead em quarentena
  });

  it('segunda mensagem do mesmo wa_id ambíguo reutiliza o MESMO lead de quarentena (não cria um segundo)', async () => {
    db.tables.leads.push(
      { id: 'lead-amb-1', doctor_id: 'D', telefone: '554396216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
      { id: 'lead-amb-2', doctor_id: 'D', telefone: '43996216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
    );
    const raw1 = JSON.stringify(payloadIdentidade({ from: '554396216864', messageId: 'wamid.ambiguous-again-1' }));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw1)).set('Content-Type', 'application/json').send(raw1);
    await new Promise((r) => setTimeout(r, 700));
    expect(db.tables.leads).toHaveLength(3);
    const quarentenaId = db.tables.leads.find((l) => !['lead-amb-1', 'lead-amb-2'].includes(l.id)).id;

    const raw2 = JSON.stringify(payloadIdentidade({ from: '554396216864', messageId: 'wamid.ambiguous-again-2', body: 'segunda msg' }));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw2)).set('Content-Type', 'application/json').send(raw2);
    await new Promise((r) => setTimeout(r, 700));

    expect(db.tables.leads).toHaveLength(3); // nenhum lead novo na segunda mensagem
    const recebidas = db.tables.conversations.filter((c) => c.direcao === 'recebida');
    expect(recebidas).toHaveLength(2);
    expect(recebidas.every((c) => c.lead_id === quarentenaId)).toBe(true); // as duas foram pro mesmo lead
    expect(processarMensagemComIA).not.toHaveBeenCalled();
  });

  it('duas mensagens diferentes concorrentes do mesmo wa_id ambíguo: exatamente UM lead de quarentena, exatamente DUAS conversas, IA nunca chamada', async () => {
    db.tables.leads.push(
      { id: 'lead-amb-1', doctor_id: 'D', telefone: '554396216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
      { id: 'lead-amb-2', doctor_id: 'D', telefone: '43996216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
    );
    const raw1 = JSON.stringify(payloadIdentidade({ from: '554396216864', messageId: 'wamid.concurrent-1', body: 'primeira' }));
    const raw2 = JSON.stringify(payloadIdentidade({ from: '554396216864', messageId: 'wamid.concurrent-2', body: 'segunda' }));
    // As duas requisições disparam AO MESMO TEMPO (Promise.all) — é isso que
    // exercita a corrida real: nenhuma das duas vê o lead que a outra está
    // criando até o índice único (doctor_id, whatsapp_wa_id) decidir.
    await Promise.all([
      request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw1)).set('Content-Type', 'application/json').send(raw1),
      request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw2)).set('Content-Type', 'application/json').send(raw2),
    ]);
    await new Promise((r) => setTimeout(r, 800));

    const quarentenas = db.tables.leads.filter((l) => !['lead-amb-1', 'lead-amb-2'].includes(l.id));
    expect(quarentenas).toHaveLength(1); // exatamente UM lead de quarentena, nunca dois
    const recebidas = db.tables.conversations.filter((c) => c.direcao === 'recebida');
    expect(recebidas).toHaveLength(2); // as DUAS mensagens preservadas, nenhuma perdida
    expect(recebidas.every((c) => c.lead_id === quarentenas[0].id)).toBe(true);
    expect(processarMensagemComIA).not.toHaveBeenCalled();
  });

  it('mesmo wa_id ambíguo em médicos diferentes cria quarentenas SEPARADAS', async () => {
    db.tables.leads.push(
      { id: 'lead-amb-d1a', doctor_id: 'D', telefone: '554396216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
      { id: 'lead-amb-d1b', doctor_id: 'D', telefone: '43996216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
      { id: 'lead-amb-d2a', doctor_id: 'D2', telefone: '554396216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
      { id: 'lead-amb-d2b', doctor_id: 'D2', telefone: '43996216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
    );
    const rawD1 = JSON.stringify(payloadIdentidade({ phoneNumberId: 'pn-1', from: '554396216864', messageId: 'wamid.amb-cross-d1' }));
    const rawD2 = JSON.stringify(payloadIdentidade({ phoneNumberId: 'pn-2', from: '554396216864', messageId: 'wamid.amb-cross-d2' }));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(rawD1)).set('Content-Type', 'application/json').send(rawD1);
    await new Promise((r) => setTimeout(r, 700));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(rawD2)).set('Content-Type', 'application/json').send(rawD2);
    await new Promise((r) => setTimeout(r, 700));

    const quarentenaD1 = db.tables.leads.find((l) => l.doctor_id === 'D' && !['lead-amb-d1a', 'lead-amb-d1b'].includes(l.id));
    const quarentenaD2 = db.tables.leads.find((l) => l.doctor_id === 'D2' && !['lead-amb-d2a', 'lead-amb-d2b'].includes(l.id));
    expect(quarentenaD1).toBeTruthy();
    expect(quarentenaD2).toBeTruthy();
    expect(quarentenaD1.id).not.toBe(quarentenaD2.id); // quarentenas separadas, nunca cruzam médico
  });

  it('retry do mesmo webhook (mesmo message.id) na quarentena não duplica conversa', async () => {
    db.tables.leads.push(
      { id: 'lead-amb-1', doctor_id: 'D', telefone: '554396216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
      { id: 'lead-amb-2', doctor_id: 'D', telefone: '43996216864', telefone_normalizado: null, whatsapp_wa_id: null, status_atual: 'lead', atendido_por: null },
    );
    const raw = JSON.stringify(payloadIdentidade({ from: '554396216864', messageId: 'wamid.retry-quarantine' }));
    const sig = sign(raw);
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sig).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 700));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sig).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 700));

    const quarentenas = db.tables.leads.filter((l) => !['lead-amb-1', 'lead-amb-2'].includes(l.id));
    expect(quarentenas).toHaveLength(1);
    expect(db.tables.conversations.filter((c) => c.direcao === 'recebida')).toHaveLength(1); // replay não duplica
  });

  it('médico A nunca encontra (nem reaproveita) lead do médico B com o mesmo telefone', async () => {
    db.tables.leads.push({ id: 'lead-b', doctor_id: 'D2', telefone: '554396216864', telefone_normalizado: '5543996216864', whatsapp_wa_id: '554396216864', status_atual: 'lead', atendido_por: null });
    // mesma identidade de telefone, mas chega pelo phone_number_id do médico D (pn-1), não D2 (pn-2)
    const raw = JSON.stringify(payloadIdentidade({ phoneNumberId: 'pn-1', from: '554396216864', messageId: 'wamid.cross-doctor' }));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw)).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 700));
    const leadsDoD = db.tables.leads.filter((l) => l.doctor_id === 'D');
    expect(leadsDoD).toHaveLength(1); // um lead NOVO criado pra D, nunca o de D2 reaproveitado
    expect(db.tables.leads.find((l) => l.id === 'lead-b').doctor_id).toBe('D2'); // intocado
  });

  // A rota simula digitação humana (pausaMs = 600 + tamanho da resposta*20,
  // aqui ~640ms para "oi") ANTES de chamar sendWhatsAppMessage — por isso
  // estes dois testes esperam mais que os 50ms usados pelos demais, que nunca
  // verificam chamada à Meta.
  it('telefone canônico válido: resposta da IA usa o E.164 canônico no envio', async () => {
    const raw = JSON.stringify(payloadIdentidade({ from: '5511987654321', messageId: 'wamid.valid-send' }));
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw)).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 800));
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessage.mock.calls[0][2]).toBe('5511987654321');
  });

  it('telefone inválido/não determinístico nunca chama a Meta (bloqueia antes do envio)', async () => {
    const raw = JSON.stringify(payloadIdentidade({ from: '5511999', messageId: 'wamid.invalid-send' })); // curto demais
    await request(app).post('/webhooks/whatsapp').set('X-Hub-Signature-256', sign(raw)).set('Content-Type', 'application/json').send(raw);
    await new Promise((r) => setTimeout(r, 800));
    expect(processarMensagemComIA).toHaveBeenCalledTimes(1); // IA ainda roda
    expect(sendWhatsAppMessage).not.toHaveBeenCalled(); // mas o envio é bloqueado
  });
});
