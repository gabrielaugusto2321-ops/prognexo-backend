import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';
import { isWhatsappOperacional, gatewaysComWebhookRecebido } from '../lib/integrationStatus.js';

const router = Router();
router.use(requireAuth);

async function resolveDoctorId(user, queryDoctorId) {
  if (user.role === 'doctor') {
    const { data } = await supabase.from('doctors').select('id').eq('owner_user_id', user.id).single();
    return data?.id ?? null;
  }
  return queryDoctorId ?? null;
}

// GET /onboarding?doctor_id= (obrigatório se for admin)
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const doctorId = await resolveDoctorId(req.user, req.query.doctor_id);

  if (!doctorId) return res.status(400).json({ error: 'doctor_id necessário' });
  if (scopedIds && !scopedIds.includes(doctorId)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  // Passo 1: WhatsApp operacional — mesma definição usada em GET /integrations
  // (src/lib/integrationStatus.js) e nos caminhos reais de envio de mensagem.
  const { data: whatsappIntegracao } = await supabase
    .from('integrations')
    .select('external_id, access_token, access_token_encrypted')
    .eq('doctor_id', doctorId)
    .eq('gateway', 'whatsapp')
    .maybeSingle();
  const whatsapp = isWhatsappOperacional(whatsappIntegracao);

  // Passo 2: pelo menos um gateway de pagamento com webhook comprovado
  // (qualquer status de transação) — mesma definição de "integração
  // comprovada" usada em GET /integrations, não só transação paga.
  const gatewaysComWebhook = await gatewaysComWebhookRecebido(doctorId);
  const pagamento = gatewaysComWebhook.size > 0;

  // Passo 3: já convidou pelo menos 1 closer
  const { count: totalClosers } = await supabase
    .from('user_doctor_access')
    .select('user_id', { count: 'exact', head: true })
    .eq('doctor_id', doctorId);
  const equipe = (totalClosers ?? 0) > 0;

  res.json({ whatsapp, pagamento, equipe });
});

export default router;
