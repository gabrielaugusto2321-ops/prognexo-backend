import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const GATEWAYS = ['kiwify', 'hotmart', 'ticto', 'pagarme', 'whatsapp'];

async function resolveDoctorId(user, queryDoctorId) {
  if (user.role === 'doctor') {
    const { data } = await supabase.from('doctors').select('id').eq('owner_user_id', user.id).single();
    return data?.id ?? null;
  }
  // admin pode consultar as integrações de qualquer médico
  return queryDoctorId ?? null;
}

// GET /integrations?doctor_id= (obrigatório se for admin)
// Garante que os 5 tokens existam (cria os que faltarem) e devolve todos.
router.get('/', async (req, res) => {
  const doctorId = await resolveDoctorId(req.user, req.query.doctor_id);
  if (!doctorId) return res.status(400).json({ error: 'doctor_id necessário' });

  for (const gateway of GATEWAYS) {
    await supabase
      .from('integrations')
      .upsert({ doctor_id: doctorId, gateway }, { onConflict: 'doctor_id,gateway', ignoreDuplicates: true });
  }

  const { data, error } = await supabase.from('integrations').select('*').eq('doctor_id', doctorId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /integrations/whatsapp — médico informa o phone_number_id do próprio WhatsApp
router.patch('/whatsapp', async (req, res) => {
  const doctorId = await resolveDoctorId(req.user, req.body.doctor_id);
  if (!doctorId) return res.status(400).json({ error: 'doctor_id necessário' });

  const { external_id } = req.body;
  const { data, error } = await supabase
    .from('integrations')
    .update({ external_id })
    .eq('doctor_id', doctorId)
    .eq('gateway', 'whatsapp')
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
