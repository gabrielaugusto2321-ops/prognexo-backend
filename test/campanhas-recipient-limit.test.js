// FASE 2 (auditoria) — limite de destinatários é tudo-ou-nada: excede ->
// rejeita a operação INTEIRA com 422 antes de criar qualquer ledger/job,
// nunca envia um subconjunto truncado.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
process.env.WHATSAPP_SEND_INTERVAL_MS = '0';

let db;
const sendWhatsAppMessage = vi.fn(async () => ({}));
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage, sendWhatsAppTemplate: vi.fn(async () => ({ messageId: 'wamid.mock' })) }));

const OWNER = '00000000-0000-4000-9300-0000000ow01';
const DOC = '00000000-0000-4000-9300-0000000000d1';
const CAMP = '00000000-0000-4000-9300-00000000ca01';

async function appWithCap(cap) {
  vi.resetModules();
  process.env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS = String(cap);
  return (await import('../src/server.js')).app;
}

function seed(leadCount) {
  sendWhatsAppMessage.mockClear();
  db = makeDb({
    users: [{ id: OWNER, role: 'doctor', ativo: true }],
    doctors: [{ id: DOC, owner_user_id: OWNER }],
    integrations: [{ doctor_id: DOC, gateway: 'whatsapp', external_id: 'pn', access_token: 'tok' }],
    campanhas: [{ id: CAMP, doctor_id: DOC, status: 'rascunho', mensagem: 'oi', modo_envio: 'texto_livre' }],
    leads: Array.from({ length: leadCount }, (_, i) => ({
      id: `L${i + 1}`, doctor_id: DOC, telefone_normalizado: `551198765${String(4320 + i).padStart(4, '0')}`,
      whatsapp_authorization_status: 'autorizado', status_atual: 'lead',
    })),
    conversations: Array.from({ length: leadCount }, (_, i) => ({
      lead_id: `L${i + 1}`, direcao: 'recebida', timestamp_msg: new Date().toISOString(),
    })),
    campanha_envios: [],
  });
  db.setAuthUser('owner', { id: OWNER });
}

describe('POST /campanhas/:id/enviar — limite de destinatários (422, tudo-ou-nada)', () => {
  it('elegíveis > limite -> 422 campaign_recipient_limit_exceeded com as duas quantidades, nada é enviado', async () => {
    const app = await appWithCap(2);
    seed(3);
    const res = await request(app).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'campaign_recipient_limit_exceeded', eligible_count: 3, max_recipients: 2 });
    await new Promise((r) => setTimeout(r, 300));
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    // nenhum ledger criado — nem pra quem estaria dentro do limite
    expect(db.tables.campanha_envios).toHaveLength(0);
    // campanha nunca sai de rascunho — a rejeição acontece ANTES da aquisição atômica
    expect(db.tables.campanhas.find((c) => c.id === CAMP).status).toBe('rascunho');
  });

  it('elegíveis == limite -> aceita normalmente, envia todos', async () => {
    const app = await appWithCap(2);
    seed(2);
    const res = await request(app).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 400));
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(2);
    expect(db.tables.campanhas.find((c) => c.id === CAMP).status).toBe('concluida');
  });

  it('elegíveis < limite -> aceita normalmente', async () => {
    const app = await appWithCap(100);
    seed(3);
    const res = await request(app).post(`/campanhas/${CAMP}/enviar`).set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 400));
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(3);
  });
});
