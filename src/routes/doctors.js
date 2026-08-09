import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /doctors — lista os médicos que o usuário logado pode ver
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);

  let query = supabase.from('doctors').select('*').order('criado_em', { ascending: false });
  if (scopedIds) query = query.in('id', scopedIds);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /doctors — só admin cria médico novo
router.post('/', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Só admin pode cadastrar médicos' });
  }

  const { data, error } = await supabase.from('doctors').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

export default router;
