import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// Testes comportamentais de isolamento entre clínicas.
process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

// IDs em formato UUID v4 (os schemas zod exigem uuid).
const uuid = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const U = {
  ownerA: uuid(1), ownerB: uuid(2), closerA1: uuid(3), closerA2: uuid(4),
  docA: uuid(5), docB: uuid(6), leadA: uuid(7), leadB: uuid(8),
  dealA: uuid(9), dealB: 'a000000a-0000-4000-8000-000000000000',
  evtA: 'b000000b-0000-4000-8000-000000000000', evtB: 'c000000c-0000-4000-8000-000000000000',
};

let db;
vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage: vi.fn(async () => ({})), sendWhatsAppTemplate: vi.fn(async () => ({ messageId: 'wamid.mock' })) }));
vi.mock('../src/lib/googleCalendar.js', () => ({
  criarEventoNoGoogle: vi.fn(async () => null),
  temConflito: vi.fn(async () => false),
  buildAuthUrl: () => '#',
  trocarCodigoPorTokens: vi.fn(),
  estaConectado: vi.fn(async () => false),
}));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));

const { app } = await import('../src/server.js');

const as = (token) => ({ Authorization: `Bearer ${token}` });

beforeEach(() => {
  db = makeDb({
    users: [
      { id: U.ownerA, email: 'a@own.test', role: 'doctor', ativo: true, nome: 'A' },
      { id: U.ownerB, email: 'b@own.test', role: 'doctor', ativo: true, nome: 'B' },
      { id: U.closerA1, email: 'c1@a.test', role: 'closer', ativo: true, nome: 'C1' },
      { id: U.closerA2, email: 'c2@a.test', role: 'closer', ativo: true, nome: 'C2' },
    ],
    doctors: [
      { id: U.docA, owner_user_id: U.ownerA, plano: 'gratuito' },
      { id: U.docB, owner_user_id: U.ownerB, plano: 'gratuito' },
    ],
    user_doctor_access: [
      { user_id: U.closerA1, doctor_id: U.docA },
      { user_id: U.closerA2, doctor_id: U.docA },
    ],
    leads: [
      { id: U.leadA, doctor_id: U.docA, sdr_responsavel_id: U.closerA1, status_atual: 'lead', telefone: '551199' },
      { id: U.leadB, doctor_id: U.docB, sdr_responsavel_id: null, status_atual: 'lead', telefone: '551188' },
    ],
    deals: [
      { id: U.dealA, lead_id: U.leadA, sdr_responsavel_id: U.closerA1, etapa: 'lead' },
      { id: U.dealB, lead_id: U.leadB, sdr_responsavel_id: null, etapa: 'lead' },
    ],
    events: [
      { id: U.evtA, doctor_id: U.docA, responsavel_id: U.closerA1, status: 'pendente', inicio: '2026-01-01T10:00:00Z' },
      { id: U.evtB, doctor_id: U.docB, responsavel_id: U.ownerB, status: 'pendente', inicio: '2026-01-01T10:00:00Z' },
    ],
    integrations: [{ doctor_id: U.docA, gateway: 'whatsapp', external_id: 'pn-A', access_token: 'tok' }],
    conversations: [{ lead_id: U.leadA, direcao: 'recebida', timestamp_msg: new Date().toISOString() }],
  });
  db.setAuthUser('ownerA', { id: U.ownerA });
  db.setAuthUser('ownerB', { id: U.ownerB });
  db.setAuthUser('c1', { id: U.closerA1 });
  db.setAuthUser('c2', { id: U.closerA2 });
});

describe('isolamento entre clínicas (comportamental)', () => {
  it('doctor A NÃO altera lead da clínica B (PATCH /leads/:id)', async () => {
    const res = await request(app).patch(`/leads/${U.leadB}`).set(as('ownerA')).send({ status_atual: 'fechado' });
    expect(res.status).toBe(403);
    expect(db.tables.leads.find((l) => l.id === U.leadB).status_atual).toBe('lead');
  });

  it('doctor A NÃO move deal da clínica B (PATCH /deals/:id/etapa)', async () => {
    const res = await request(app).patch(`/deals/${U.dealB}/etapa`).set(as('ownerA')).send({ etapa: 'fechado' });
    expect(res.status).toBe(403);
    expect(db.tables.deals.find((d) => d.id === U.dealB).etapa).toBe('lead');
  });

  it('doctor A NÃO marca status de evento da clínica B (PATCH /events/:id/status)', async () => {
    const res = await request(app).patch(`/events/${U.evtB}/status`).set(as('ownerA')).send({ status: 'compareceu' });
    expect(res.status).toBe(403);
  });

  it('doctor A NÃO envia WhatsApp para lead da clínica B (POST /conversations/send)', async () => {
    const res = await request(app).post('/conversations/send').set(as('ownerA')).send({ lead_id: U.leadB, texto: 'oi' });
    expect(res.status).toBe(403);
  });

  it('closerA2 NÃO atua na carteira do closerA1', async () => {
    const res = await request(app).patch(`/leads/${U.leadA}`).set(as('c2')).send({ status_atual: 'fechado' });
    expect(res.status).toBe(403);
  });

  it('POST /leads: closer não atribui lead a outro closer', async () => {
    const res = await request(app)
      .post('/leads')
      .set(as('c1'))
      .send({ doctor_id: U.docA, nome: 'Novo', sdr_responsavel_id: U.closerA2 });
    expect(res.status).toBe(403);
  });

  it('POST /events cross-tenant: doctor A não cria evento na clínica B', async () => {
    const res = await request(app)
      .post('/events')
      .set(as('ownerA'))
      .send({ doctor_id: U.docB, tipo: 'consulta', titulo: 'x', inicio: '2026-02-01T10:00:00Z' });
    expect(res.status).toBe(403);
  });

  it('doctor A altera o próprio lead normalmente (caminho feliz)', async () => {
    const res = await request(app).patch(`/leads/${U.leadA}`).set(as('ownerA')).send({ status_atual: 'fechado' });
    expect(res.status).toBe(200);
    expect(db.tables.leads.find((l) => l.id === U.leadA).status_atual).toBe('fechado');
  });

  it('GET /leads mantém o enriquecimento (horas_sem_interacao / esfriando)', async () => {
    const res = await request(app).get('/leads').set(as('ownerA'));
    expect(res.status).toBe(200);
    const lead = res.body.find((l) => l.id === U.leadA);
    expect(lead).toBeTruthy();
    expect(lead).toHaveProperty('horas_sem_interacao');
    expect(lead).toHaveProperty('esfriando');
  });

  it('GET /deals mantém o achatamento do kanban (lead_nome / tipo)', async () => {
    const res = await request(app).get('/deals').set(as('ownerA'));
    expect(res.status).toBe(200);
    const deal = res.body.find((d) => d.id === U.dealA);
    expect(deal).toBeTruthy();
    expect(deal).toHaveProperty('lead_nome');
    expect(deal).toHaveProperty('tipo');
  });
});
