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
  // Só admin pode consultar/editar integrações de outro médico via query param
  if (user.role === 'admin') return queryDoctorId ?? null;
  return null;
}

// GET /integrations?doctor_id= (obrigatório se for admin)
// Garante que os 5 tokens existam (cria os que faltarem) e devolve todos.
// access_token nunca volta no JSON — é write-only, só pra não vazar segredo pro frontend.
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

  const semSegredo = data.map(({ access_token, ...resto }) => ({
    ...resto,
    access_token_configurado: Boolean(access_token),
  }));

  res.json(semSegredo);
});

// PATCH /integrations/whatsapp — médico informa o phone_number_id e/ou o
// access_token permanente do próprio WhatsApp (gerado no Meta for Developers).
router.patch('/whatsapp', async (req, res) => {
  const doctorId = await resolveDoctorId(req.user, req.body.doctor_id);
  if (!doctorId) return res.status(400).json({ error: 'doctor_id necessário' });

  const { external_id, access_token } = req.body;
  const camposParaAtualizar = {};
  if (external_id !== undefined) camposParaAtualizar.external_id = external_id;
  if (access_token !== undefined) camposParaAtualizar.access_token = access_token;

  if (Object.keys(camposParaAtualizar).length === 0) {
    return res.status(400).json({ error: 'Nada para atualizar' });
  }

  const { data, error } = await supabase
    .from('integrations')
    .update(camposParaAtualizar)
    .eq('doctor_id', doctorId)
    .eq('gateway', 'whatsapp')
    .select('doctor_id, gateway, external_id')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ...data, access_token_configurado: Boolean(access_token) });
});

export default router;
