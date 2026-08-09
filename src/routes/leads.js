import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds, isScopedToOwnLeadsOnly } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /leads?doctor_id=&journey_type=&status=
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id, journey_type, status } = req.query;

  let query = supabase.from('leads').select('*').order('criado_em', { ascending: false });

  if (scopedIds) query = query.in('doctor_id', scopedIds);
  if (doctor_id) query = query.eq('doctor_id', doctor_id);
  if (journey_type) query = query.eq('journey_type', journey_type);
  if (status) query = query.eq('status_atual', status);

  // Closer só vê a própria carteira — não o funil inteiro do médico
  if (isScopedToOwnLeadsOnly(req.user)) {
    query = query.eq('sdr_responsavel_id', req.user.id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /leads — criação manual ou via integração externa (quiz, formulário)
router.post('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const payload = req.body;

  if (scopedIds && !scopedIds.includes(payload.doctor_id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const { data, error } = await supabase
    .from('leads')
    .insert(payload)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Cria automaticamente o deal correspondente na etapa "lead"
  await supabase.from('deals').insert({
    lead_id: data.id,
    product_id: payload.product_id ?? null,
    etapa: 'lead',
    sdr_responsavel_id: payload.sdr_responsavel_id ?? null,
  });

  res.status(201).json(data);
});

// PATCH /leads/:id — atualizar status manualmente, ou reatribuir o closer responsável
router.patch('/:id', async (req, res) => {
  const { id } = req.params;

  // Closer não pode reatribuir leads pra si mesmo nem tirar de outro — só doctor/admin fazem isso
  if (isScopedToOwnLeadsOnly(req.user) && 'sdr_responsavel_id' in req.body) {
    return res.status(403).json({ error: 'Somente o médico ou admin pode reatribuir responsável' });
  }

  const { data, error } = await supabase
    .from('leads')
    .update(req.body)
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
