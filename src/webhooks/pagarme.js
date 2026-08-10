import { Router } from 'express';
import { normalizeStatus, registrarTransacao, resolveDoctorFromToken } from '../lib/salesWebhook.js';

const router = Router();

// POST /webhooks/pagarme?secret=TOKEN_UNICO_DO_MEDICO
// O deal_id vem no metadata da cobrança (definido na hora de criá-la) —
// o token só confirma de qual médico é essa cobrança.
router.post('/', async (req, res) => {
  const token = req.query.secret;
  const doctorId = await resolveDoctorFromToken('pagarme', token);
  if (!doctorId) {
    return res.status(401).json({ error: 'Token inválido' });
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
