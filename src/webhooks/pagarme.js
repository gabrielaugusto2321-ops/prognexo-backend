import { paymentWebhook, hmacSha1 } from './paymentFactory.js';

// POST /webhooks/pagarme
// Autenticidade: HMAC-SHA1 do corpo bruto com PAGARME_WEBHOOK_SECRET, no header
// `X-Hub-Signature` — ver docs/platform/WEBHOOKS.md.
// O deal_id vem no metadata da cobrança e é validado contra o tenant do token.
export default paymentWebhook({
  provider: 'pagarme',
  secretEnv: 'PAGARME_WEBHOOK_SECRET',
  signature: hmacSha1('X-Hub-Signature'),
  parse: (e) => ({
    id: e?.data?.id,
    eventId: e?.id || e?.data?.id,
    status: e?.data?.status, // paid | failed | refunded | pending
    valor: e?.data?.amount ? e.data.amount / 100 : null,
    dealId: e?.data?.metadata?.deal_id,
    method: e?.data?.payment_method,
  }),
});
