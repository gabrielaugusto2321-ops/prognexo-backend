import { paymentWebhook, staticToken } from './paymentFactory.js';

// POST /webhooks/hotmart
// Autenticidade: header/body `hottok` (token estático da conta) comparado em
// tempo constante com HOTMART_HOTTOK. A Hotmart não assina o corpo —
// ver docs/platform/WEBHOOKS.md.
export default paymentWebhook({
  provider: 'hotmart',
  secretEnv: 'HOTMART_HOTTOK',
  signature: staticToken('X-HOTMART-HOTTOK', 'hottok'),
  parse: (b) => ({
    id: b?.data?.purchase?.transaction,
    eventId: b?.id || b?.data?.purchase?.transaction,
    status: b?.event, // PURCHASE_APPROVED | PURCHASE_CANCELED | PURCHASE_REFUNDED | PURCHASE_CHARGEBACK
    valor: b?.data?.purchase?.price?.value,
    email: b?.data?.buyer?.email,
    telefone: b?.data?.buyer?.phone,
    method: b?.data?.purchase?.payment?.type,
  }),
});
