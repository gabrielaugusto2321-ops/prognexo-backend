import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// Este arquivo sobe o app em NODE_ENV=production para provar que o webhook da
// Ticto (sem assinatura criptográfica) fica DESABILITADO por padrão.
process.env.NODE_ENV = 'production';
// server.js escuta em produção; porta efêmera evita EADDRINUSE (3333) contra
// outros testes que também sobem o app em produção, em workers paralelos.
process.env.PORT = '0';
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
process.env.PAYMENT_WEBHOOKS_ENFORCE_SIGNATURE = 'false';
process.env.PAGARME_WEBHOOK_SECRET = 'x';
process.env.KIWIFY_WEBHOOK_SECRET = 'x';
process.env.HOTMART_HOTTOK = 'x';
// TICTO_WEBHOOK_ENABLED NÃO definido → deve ficar desligado

vi.mock('../src/lib/supabase.js', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { doctor_id: 'D' } }) }) }) }) }),
  },
}));

const { createApp } = await import('../src/server.js');
const app = createApp();

describe('Ticto webhook em produção', () => {
  it('sem TICTO_WEBHOOK_ENABLED → 503 e não processa', async () => {
    const res = await request(app)
      .post('/webhooks/ticto')
      .set('X-Prognexo-Webhook-Token', 'algum-token')
      .send({ status: 'authorized', order: { hash: 'h1' } });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('webhook_disabled');
  });
});
