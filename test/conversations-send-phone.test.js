import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
const sendWhatsAppMessage = vi.fn(async () => ({}));
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage }));

const { app } = await import('../src/server.js');

const DOC = '00000000-0000-4000-9000-000000000d01';
const OWNER = '00000000-0000-4000-9000-000000000u01';
const LEAD_OK = '00000000-0000-4000-9000-00000000ea01';
const LEAD_BAD = '00000000-0000-4000-9000-00000000ea02';
const LEAD_QUARANTINE = '00000000-0000-4000-9000-00000000ea03';

beforeEach(() => {
  sendWhatsAppMessage.mockClear();
  db = makeDb({
    users: [{ id: OWNER, role: 'doctor', ativo: true }],
    doctors: [{ id: DOC, owner_user_id: OWNER }],
    integrations: [{ doctor_id: DOC, gateway: 'whatsapp', external_id: 'pn-1', access_token: 'tok' }],
    leads: [
      { id: LEAD_OK, doctor_id: DOC, telefone: '554396216864', telefone_normalizado: '5543996216864' }, // legado sem o 9 no bruto, canônico correto já resolvido
      { id: LEAD_BAD, doctor_id: DOC, telefone: 'nao-e-telefone', telefone_normalizado: null },
      {
        id: LEAD_QUARANTINE, doctor_id: DOC, telefone: '554396216864', telefone_normalizado: null,
        whatsapp_wa_id: '554396216864', whatsapp_authorization_status: 'pendente',
        dados_extraidos: { phone_identity_review_required: true, phone_identity_reason: 'ambiguous_candidates' },
      },
    ],
    conversations: [
      { lead_id: LEAD_OK, direcao: 'recebida', timestamp_msg: new Date().toISOString() },
      { lead_id: LEAD_BAD, direcao: 'recebida', timestamp_msg: new Date().toISOString() },
      { lead_id: LEAD_QUARANTINE, direcao: 'recebida', timestamp_msg: new Date().toISOString() },
    ],
  });
  db.setAuthUser('owner', { id: OWNER });
});

describe('POST /conversations/send — identidade de telefone', () => {
  it('usa o telefone canônico E.164 (telefone_normalizado), nunca o campo bruto', async () => {
    const res = await request(app).post('/conversations/send')
      .set({ Authorization: 'Bearer owner' })
      .send({ lead_id: LEAD_OK, texto: 'oi' });
    expect(res.status).toBe(200);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessage.mock.calls[0][2]).toBe('5543996216864');
  });

  it('telefone inválido/indeterminado bloqueia ANTES da Meta com invalid_recipient_phone', async () => {
    const res = await request(app).post('/conversations/send')
      .set({ Authorization: 'Bearer owner' })
      .send({ lead_id: LEAD_BAD, texto: 'oi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_recipient_phone');
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('lead em quarentena de identidade bloqueia com 409 phone_identity_review_required, nunca chama a Meta', async () => {
    const res = await request(app).post('/conversations/send')
      .set({ Authorization: 'Bearer owner' })
      .send({ lead_id: LEAD_QUARANTINE, texto: 'oi' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('phone_identity_review_required');
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
