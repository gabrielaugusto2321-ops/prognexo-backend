import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));

const { app } = await import('../src/server.js');

beforeEach(() => {
  db = makeDb({
    integrations: [
      { doctor_id: 'DA', gateway: 'pagarme', webhook_token: 'tokenA' },
      { doctor_id: 'DB', gateway: 'pagarme', webhook_token: 'tokenB' },
    ],
    deals: [
      { id: 'dealDA', lead_id: 'leadDA', etapa: 'proposta' },
      { id: 'dealDB', lead_id: 'leadDB', etapa: 'proposta' },
    ],
    leads: [
      { id: 'leadDA', doctor_id: 'DA', status_atual: 'proposta' },
      { id: 'leadDB', doctor_id: 'DB', status_atual: 'proposta' },
    ],
    transactions: [],
    webhook_events: [],
  });
});

function pagarmeBody(id, dealId) {
  return { id: `evt-${id}`, data: { id, status: 'paid', amount: 10000, metadata: { deal_id: dealId }, payment_method: 'pix' } };
}

describe('POST /webhooks/pagarme (comportamental)', () => {
  it('token inválido → 401', async () => {
    const res = await request(app).post('/webhooks/pagarme').set('X-Prognexo-Webhook-Token', 'nope').send(pagarmeBody('t1', 'dealDA'));
    expect(res.status).toBe(401);
  });

  it('token da clínica B tentando fechar deal da clínica A → deal NÃO fecha', async () => {
    const res = await request(app)
      .post('/webhooks/pagarme')
      .set('X-Prognexo-Webhook-Token', 'tokenB')
      .send(pagarmeBody('t2', 'dealDA'));
    expect(res.status).toBe(200);
    expect(db.tables.deals.find((d) => d.id === 'dealDA').etapa).toBe('proposta'); // não fechou
  });

  it('token correto fecha o próprio deal', async () => {
    const res = await request(app)
      .post('/webhooks/pagarme')
      .set('X-Prognexo-Webhook-Token', 'tokenB')
      .send(pagarmeBody('t3', 'dealDB'));
    expect(res.status).toBe(200);
    expect(db.tables.deals.find((d) => d.id === 'dealDB').etapa).toBe('fechado');
    expect(db.tables.transactions).toHaveLength(1);
  });

  it('replay do mesmo evento → no-op idempotente', async () => {
    const body = pagarmeBody('t4', 'dealDB');
    const first = await request(app).post('/webhooks/pagarme').set('X-Prognexo-Webhook-Token', 'tokenB').send(body);
    const second = await request(app).post('/webhooks/pagarme').set('X-Prognexo-Webhook-Token', 'tokenB').send(body);
    expect(first.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(db.tables.transactions).toHaveLength(1);
  });
});
