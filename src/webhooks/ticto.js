import { Router } from 'express';
import { normalizeStatus, registrarTransacao, encontrarDealPorContato } from '../lib/salesWebhook.js';

const router = Router();

// POST /webhooks/ticto
// Formato real da Ticto (v2.0): { status: 'authorized'|'refused'|'refunded', token, payment_method,
//   order: { id, hash, transaction_hash, paid_amount, order_date }, item: { product_name, product_id } }
// A Ticto valida por um "token" fixo da sua conta, enviado em todo payload —
// comparamos com o valor salvo no .env.
router.post('/', async (req, res) => {
  const token = req.body?.token;
  if (token !== process.env.TICTO_TOKEN) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const body = req.body;
  const rawStatus = body?.status; // 'authorized' | 'refused' | 'refunded'
  const orderId = body?.order?.transaction_hash ?? body?.order?.hash;
  const valor = body?.order?.paid_amount ? body.order.paid_amount / 100 : null;
  // Confirmar nome exato do campo de contato assim que tivermos um payload real de teste —
  // a doc pública não deixou claro se vem em "customer" ou dentro de outro objeto.
  const email = body?.customer?.email;
  const telefone = body?.customer?.phone;

  if (!orderId || !rawStatus) {
    return res.status(400).json({ error: 'Payload incompleto' });
  }

  const dealId = await encontrarDealPorContato({ email, telefone });

  await registrarTransacao({
    gateway: 'ticto',
    gatewayTransactionId: orderId,
    valor,
    status: normalizeStatus(rawStatus === 'authorized' ? 'authorized' : rawStatus),
    metodoPagamento: body?.payment_method,
    dealId,
  });

  res.status(200).json({ ok: true });
});

export default router;
