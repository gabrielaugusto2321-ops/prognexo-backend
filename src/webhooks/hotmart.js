import { Router } from 'express';
import { normalizeStatus, registrarTransacao, encontrarDealPorContato } from '../lib/salesWebhook.js';

const router = Router();

// POST /webhooks/hotmart
// Formato real da Hotmart (Webhook 2.0): { event: 'PURCHASE_APPROVED', data: { buyer, purchase, product } }
// Autenticação: a Hotmart manda o "Hottok" da sua conta dentro do payload (data.subscription
// ou no header, dependendo da versão) — comparamos com o valor salvo no .env.
router.post('/', async (req, res) => {
  const hottok = req.body?.hottok ?? req.headers['x-hotmart-hottok'];
  if (hottok !== process.env.HOTMART_HOTTOK) {
    return res.status(401).json({ error: 'Hottok inválido' });
  }

  const event = req.body?.event; // 'PURCHASE_APPROVED' | 'PURCHASE_CANCELED' | 'PURCHASE_REFUNDED' | 'PURCHASE_CHARGEBACK'
  const data = req.body?.data;
  const transactionId = data?.purchase?.transaction;
  const valor = data?.purchase?.price?.value;
  const email = data?.buyer?.email;
  const telefone = data?.buyer?.phone;

  if (!transactionId || !event) {
    return res.status(400).json({ error: 'Payload incompleto' });
  }

  const dealId = await encontrarDealPorContato({ email, telefone });

  await registrarTransacao({
    gateway: 'hotmart',
    gatewayTransactionId: transactionId,
    valor,
    status: normalizeStatus(event),
    metodoPagamento: data?.purchase?.payment?.type,
    dealId,
  });

  res.status(200).json({ ok: true });
});

export default router;
