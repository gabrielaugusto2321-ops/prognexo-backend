import { Router } from 'express';
import { normalizeStatus, registrarTransacao } from '../lib/salesWebhook.js';

const router = Router();

// POST /webhooks/pagarme
// A Pagar.me manda o deal_id no metadata da cobrança — é você quem define isso
// na hora de criar a cobrança (metadata: { deal_id: '...' }).
router.post('/', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== process.env.PAGARME_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  const evento = req.body;
  const transactionId = evento?.data?.id;
  const rawStatus = evento?.data?.status; // 'paid' | 'failed' | 'refunded' | 'pending'
  const valor = evento?.data?.amount ? evento.data.amount / 100 : null;
  const dealId = evento?.data?.metadata?.deal_id;

  if (!transactionId || !rawStatus) {
    return res.status(400).json({ error: 'Payload incompleto' });
  }

  await registrarTransacao({
    gateway: 'pagarme',
    gatewayTransactionId: transactionId,
    valor,
    status: normalizeStatus(rawStatus),
    metodoPagamento: evento?.data?.payment_method,
    dealId,
  });

  res.status(200).json({ ok: true });
});

export default router;
