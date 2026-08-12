import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';

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

  // Passo 1: WhatsApp conectado — tem phone_number_id salvo?
  const { data: whatsappIntegracao } = await supabase
    .from('integrations')
    .select('external_id')
    .eq('doctor_id', doctorId)
    .eq('gateway', 'whatsapp')
    .maybeSingle();
  const whatsapp = !!whatsappIntegracao?.external_id;

  // Passo 2: pelo menos 1 pagamento de verdade já chegou (qualquer plataforma)
  const { data: leadsDoMedico } = await supabase.from('leads').select('id').eq('doctor_id', doctorId);
  const leadIds = (leadsDoMedico || []).map((l) => l.id);
  let pagamento = false;
  if (leadIds.length > 0) {
    const { data: dealsDoMedico } = await supabase.from('deals').select('id').in('lead_id', leadIds);
    const dealIds = (dealsDoMedico || []).map((d) => d.id);
    if (dealIds.length > 0) {
      const { count } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .in('deal_id', dealIds)
        .eq('status', 'pago');
      pagamento = (count ?? 0) > 0;
    }
  }

  // Passo 3: já convidou pelo menos 1 closer
  const { count: totalClosers } = await supabase
    .from('user_doctor_access')
    .select('user_id', { count: 'exact', head: true })
    .eq('doctor_id', doctorId);
  const equipe = (totalClosers ?? 0) > 0;

  res.json({ whatsapp, pagamento, equipe });
});

export default router;
