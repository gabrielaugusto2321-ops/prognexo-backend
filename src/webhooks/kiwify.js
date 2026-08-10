import { Router } from 'express';
import { normalizeStatus, registrarTransacao, encontrarDealPorContato, resolveDoctorFromToken } from '../lib/salesWebhook.js';

const router = Router();

// POST /webhooks/kiwify?secret=TOKEN_UNICO_DO_MEDICO
// Cada médico cola essa URL (com o próprio token) no painel dele da Kiwify.
router.post('/', async (req, res) => {
  const token = req.query.secret;
  const doctorId = await resolveDoctorFromToken('kiwify', token);
  if (!doctorId) {
    return res.status(401).json({ error: 'Token inválido — verifique o link colado no painel da Kiwify' });
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

  const dealId = await encontrarDealPorContato({ email, telefone, doctorId });

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
