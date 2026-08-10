import { Router } from 'express';
import { normalizeStatus, registrarTransacao, encontrarDealPorContato, resolveDoctorFromToken } from '../lib/salesWebhook.js';

const router = Router();

// POST /webhooks/ticto?secret=TOKEN_UNICO_DO_MEDICO
router.post('/', async (req, res) => {
  const token = req.query.secret;
  const doctorId = await resolveDoctorFromToken('ticto', token);
  if (!doctorId) {
    return res.status(401).json({ error: 'Token inválido — verifique o link colado no painel da Ticto' });
  }

  const body = req.body;
  const rawStatus = body?.status; // 'authorized' | 'refused' | 'refunded'
  const orderId = body?.order?.transaction_hash ?? body?.order?.hash;
  const valor = body?.order?.paid_amount ? body.order.paid_amount / 100 : null;
  const email = body?.customer?.email;
  const telefone = body?.customer?.phone;

  if (!orderId || !rawStatus) {
    return res.status(400).json({ error: 'Payload incompleto' });
  }

  const dealId = await encontrarDealPorContato({ email, telefone, doctorId });

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
