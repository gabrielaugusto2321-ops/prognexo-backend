import { paymentWebhook, hmacSha1 } from './paymentFactory.js';

// POST /webhooks/kiwify
// Autenticidade: HMAC-SHA1 do corpo bruto com KIWIFY_WEBHOOK_SECRET, no
// parâmetro `signature` — ver docs/platform/WEBHOOKS.md.
export default paymentWebhook({
  provider: 'kiwify',
  secretEnv: 'KIWIFY_WEBHOOK_SECRET',
  signature: hmacSha1('signature'),
  parse: (b) => ({
    id: b?.order_id,
    eventId: b?.event_id || b?.order_id,
    status: b?.order_status === 'paid' ? 'approved' : b?.order_status,
    valor: b?.Commissions?.charge_amount ? b.Commissions.charge_amount / 100 : b?.product_price,
    email: b?.Customer?.email,
    telefone: b?.Customer?.mobile,
    method: b?.payment_method,
  }),
});
