import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
const sendWhatsAppMessage = vi.fn(async () => ({}));

vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage }));

const { app } = await import('../src/server.js');

const OWNER = '00000000-0000-4000-8000-0000000ow01';
const DOC = '00000000-0000-4000-8000-0000000do01';
const CAMP = '00000000-0000-4000-8000-0000000ca01';

beforeEach(() => {
  sendWhatsAppMessage.mockClear();
  db = makeDb({
    users: [{ id: OWNER, role: 'doctor', ativo: true }],
    doctors: [{ id: DOC, owner_user_id: OWNER }],
    integrations: [{ doctor_id: DOC, gateway: 'whatsapp', external_id: 'pn', access_token: 'tok' }],
    campanhas: [{ id: CAMP, doctor_id: DOC, status: 'rascunho', mensagem: 'oi', filtro_status: null }],
    leads: [
      { id: 'L1', doctor_id: DOC, telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado', status_atual: 'lead' },
      { id: 'L2', doctor_id: DOC, telefone_normalizado: '5511987654322', whatsapp_authorization_status: 'autorizado', status_atual: 'lead' },
    ],
    conversations: [
      { lead_id: 'L1', direcao: 'recebida', timestamp_msg: new Date().toISOString() },
      { lead_id: 'L2', direcao: 'recebida', timestamp_msg: new Date().toISOString() },
    ],
    campanha_envios: [],
  });
  db.setAuthUser('owner', { id: OWNER });
});

describe('POST /campanhas/:id/enviar — RACE01 (comportamental)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 100)); // deixa o envio destacado terminar

  it('duas requisições simultâneas: só uma dispara, a outra recebe 409', async () => {
    const req1 = request(app).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    const req2 = request(app).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    const [r1, r2] = await Promise.all([req1, req2]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([202, 409]);
    await settle();
    // 2 leads * 1 envio = 2; nunca 4
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
    expect(db.tables.campanhas.find((c) => c.id === CAMP).status).toBe('concluida');
  });

  it('reenvio de campanha já concluída não manda mensagem de novo', async () => {
    await request(app).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    await settle();
    sendWhatsAppMessage.mockClear();
    const again = await request(app).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(again.status).toBe(409);
    await settle();
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('campanha "processando" recente NÃO é retomável (protege a corrida)', async () => {
    db.tables.campanhas.find((c) => c.id === CAMP).status = 'processando';
    db.tables.campanhas.find((c) => c.id === CAMP).processando_desde = new Date().toISOString();
    const res = await request(app).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(409);
  });

  it('campanha "processando" órfã (>15min) É retomável — envio órfão recuperado', async () => {
    db.tables.campanhas.find((c) => c.id === CAMP).status = 'processando';
    db.tables.campanhas.find((c) => c.id === CAMP).processando_desde = new Date(Date.now() - 30 * 60_000).toISOString();
    // L1 já tinha sido enviado antes do "crash"
    db.tables.campanha_envios.push({ campanha_id: CAMP, lead_id: 'L1', status: 'enviado' });
    const res = await request(app).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await settle();
    // só L2 (o que faltava) recebe; L1 não é reenviado
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(db.tables.campanhas.find((c) => c.id === CAMP).status).toBe('concluida');
  });
});
