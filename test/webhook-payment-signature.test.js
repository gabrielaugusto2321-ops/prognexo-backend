import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// Boot em produção com os webhooks de pagamento LIGADOS e assinatura ENFORCED,
// para provar que a verificação HMAC do paymentFactory funciona de ponta a ponta.
process.env.NODE_ENV = 'production';
process.env.SUPABASE_URL = 'https://x.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.META_APP_SECRET = 'x';
process.env.META_SYSTEM_USER_TOKEN = 'x';
process.env.WHATSAPP_VERIFY_TOKEN = 'x';
process.env.VOYAGE_API_KEY = 'x';
process.env.CRON_SECRET = 'x';
process.env.FRONTEND_URL = 'https://app.test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
process.env.CAPTCHA_ENABLED = 'true';
process.env.CAPTCHA_SECRET = 'x';
process.env.PAYMENT_WEBHOOKS_ENABLED = 'true';
process.env.PAYMENT_WEBHOOKS_ENFORCE_SIGNATURE = 'true';
process.env.PAGARME_WEBHOOK_SECRET = 'pagarme-secret';
process.env.KIWIFY_WEBHOOK_SECRET = 'x';
process.env.HOTMART_HOTTOK = 'x';

const db = makeDb({
  integrations: [{ doctor_id: 'D', gateway: 'pagarme', webhook_token: 'tok' }],
  deals: [{ id: 'deal1', lead_id: 'lead1', etapa: 'proposta' }],
  leads: [{ id: 'lead1', doctor_id: 'D', status_atual: 'proposta' }],
  transactions: [],
  webhook_events: [],
});
vi.mock('../src/lib/supabase.js', () => ({ supabase: db.client }));

const { createApp } = await import('../src/server.js');
const app = createApp();

function body(id) {
  return JSON.stringify({ id: `evt-${id}`, data: { id, status: 'paid', amount: 5000, metadata: { deal_id: 'deal1' } } });
}
const sign = (raw) => crypto.createHmac('sha1', 'pagarme-secret').update(raw).digest('hex');

describe('paymentFactory — verificação de assinatura em produção', () => {
  it('assinatura HMAC-SHA1 inválida → 401', async () => {
    const raw = body('s1');
    const res = await request(app)
      .post('/webhooks/pagarme')
      .set('X-Prognexo-Webhook-Token', 'tok')
      .set('X-Hub-Signature', 'deadbeef')
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(401);
    expect(db.tables.deals.find((d) => d.id === 'deal1').etapa).toBe('proposta');
  });

  it('assinatura HMAC-SHA1 válida → 200 e fecha o deal', async () => {
    const raw = body('s2');
    const res = await request(app)
      .post('/webhooks/pagarme')
      .set('X-Prognexo-Webhook-Token', 'tok')
      .set('X-Hub-Signature', sign(raw))
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(res.status).toBe(200);
    expect(db.tables.deals.find((d) => d.id === 'deal1').etapa).toBe('fechado');
  });
});
