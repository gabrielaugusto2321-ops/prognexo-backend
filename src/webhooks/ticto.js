import { paymentWebhook, staticToken } from './paymentFactory.js';

// POST /webhooks/ticto
// A Ticto só oferece um token estático no corpo (`token`), sem assinatura
// criptográfica do payload. Por isso o endpoint fica DESABILITADO em produção
// por padrão (TICTO_WEBHOOK_ENABLED=false) — habilitar exige uma decisão
// explícita de risco. Ver docs/platform/WEBHOOKS.md.
export default paymentWebhook({
  provider: 'ticto',
  secretEnv: 'TICTO_TOKEN',
  requireEnabledEnv: 'TICTO_WEBHOOK_ENABLED',
  signature: staticToken('X-Ticto-Token', 'token'),
  parse: (b) => {
    const phone = b?.customer?.phone;
    return {
      id: b?.order?.transaction_hash ?? b?.order?.hash,
      eventId: b?.event_id ?? b?.order?.transaction_hash,
      status: b?.status, // authorized | refused | refunded | chargeback | ...
      valor: b?.order?.paid_amount ? b.order.paid_amount / 100 : null,
      email: b?.customer?.email,
      telefone: phone ? `${phone.ddi ?? ''}${phone.ddd ?? ''}${phone.number ?? ''}` : null,
      method: b?.payment_method,
    };
  },
});
