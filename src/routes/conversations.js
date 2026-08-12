import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds, isScopedToOwnLeadsOnly } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /conversations?doctor_id=&lead_id=
// Timeline de mensagens (hoje só WhatsApp), mais recente primeiro.
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id, lead_id } = req.query;

  let query = supabase
    .from('conversations')
    .select('*, leads!inner(id, nome, telefone, doctor_id, sdr_responsavel_id)')
    .order('timestamp_msg', { ascending: false })
    .limit(200);

  if (lead_id) query = query.eq('lead_id', lead_id);
  if (doctor_id) query = query.eq('leads.doctor_id', doctor_id);
  else if (scopedIds) query = query.in('leads.doctor_id', scopedIds);

  // Closer só vê conversas dos próprios leads
  if (isScopedToOwnLeadsOnly(req.user)) {
    query = query.eq('leads.sdr_responsavel_id', req.user.id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
