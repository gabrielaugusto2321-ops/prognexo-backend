import { Router } from 'express';
import { normalizeStatus, registrarTransacao, encontrarDealPorContato } from '../lib/salesWebhook.js';

const router = Router();

// POST /webhooks/kiwify
// Formato real da Kiwify: order_id, order_status ('paid'|'refused'|'refunded'|'chargedback'),
// payment_method, e um objeto "Customer" com full_name/email/mobile.
// Kiwify não tem campo de metadata customizável — por isso o deal é achado
// pelo e-mail/telefone do comprador em vez de vir explícito no payload.
router.post('/', async (req, res) => {
  const secret = req.query.secret; // Kiwify permite configurar um token na própria URL do webhook
  if (secret !== process.env.KIWIFY_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  const body = req.body;
  const orderId = body?.order_id;
  const rawStatus = body?.order_status; // 'paid' | 'refused' | 'refunded' | 'chargedback'
  const valor = body?.Commissions?.charge_amount ? body.Commissions.charge_amount / 100 : body?.product_price;
  const email = body?.Customer?.email;
  const telefone = body?.Customer?.mobile;

  if (!orderId || !rawStatus) {
    return res.status(400).json({ error: 'Payload incompleto' });
  }

  const dealId = await encontrarDealPorContato({ email, telefone });

  await registrarTransacao({
    gateway: 'kiwify',
    gatewayTransactionId: orderId,
    valor,
    status: normalizeStatus(rawStatus === 'paid' ? 'approved' : rawStatus),
    metodoPagamento: body?.payment_method,
    dealId,
  });

  res.status(200).json({ ok: true });
});

export default router;
