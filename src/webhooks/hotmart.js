import { Router } from 'express';
import { normalizeStatus, registrarTransacao, encontrarDealPorContato, resolveDoctorFromToken } from '../lib/salesWebhook.js';

const router = Router();

// POST /webhooks/hotmart?secret=TOKEN_UNICO_DO_MEDICO
router.post('/', async (req, res) => {
  const token = req.query.secret;
  const doctorId = await resolveDoctorFromToken('hotmart', token);
  if (!doctorId) {
    return res.status(401).json({ error: 'Token inválido — verifique o link colado no painel da Hotmart' });
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

  const dealId = await encontrarDealPorContato({ email, telefone, doctorId });

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
