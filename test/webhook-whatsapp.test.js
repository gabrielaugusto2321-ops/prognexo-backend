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

vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));
vi.mock('../src/lib/iaAgent.js', () => ({ processarMensagemComIA }));
vi.mock('../src/lib/knowledgeChunks.js', () => ({ buscarChunksRelevantes: vi.fn(async () => []) }));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage: vi.fn(async () => ({})) }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));

const { app } = await import('../src/server.js');

function payload(messageId = 'wamid.1') {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts: [{ wa_id: '5511999', profile: { name: 'Lead' } }],
              messages: [{ id: messageId, from: '5511999', type: 'text', text: { body: 'oi' }, timestamp: '1700000000' }],
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
  db = makeDb({
    integrations: [{ doctor_id: 'D', gateway: 'whatsapp', external_id: 'pn-1', access_token: 'tok' }],
    doctors: [{ id: 'D', ia_atendimento_ativo: true, ia_limite_mensagens: 20 }],
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
});
