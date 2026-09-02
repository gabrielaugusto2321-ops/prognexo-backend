import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

async function checarAcesso(req, doctorId) {
  const scopedIds = await getScopedDoctorIds(req.user);
  return !scopedIds || scopedIds.includes(doctorId);
}

// GET /knowledge-base?doctor_id=
router.get('/', async (req, res) => {
  const { doctor_id } = req.query;
  if (!doctor_id) return res.status(400).json({ error: 'doctor_id necessário' });
  if (!(await checarAcesso(req, doctor_id))) return res.status(403).json({ error: 'Sem acesso a este médico' });

  const { data, error } = await supabase
    .from('knowledge_base')
    .select('*')
    .eq('doctor_id', doctor_id)
    .order('criado_em', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /knowledge-base  { doctor_id, titulo, conteudo }
router.post('/', async (req, res) => {
  const { doctor_id, titulo, conteudo } = req.body;
  if (!doctor_id || !titulo?.trim() || !conteudo?.trim()) {
    return res.status(400).json({ error: 'doctor_id, titulo e conteudo são obrigatórios' });
  }
  if (!(await checarAcesso(req, doctor_id))) return res.status(403).json({ error: 'Sem acesso a este médico' });

  const { data, error } = await supabase
    .from('knowledge_base')
    .insert({ doctor_id, titulo: titulo.trim(), conteudo: conteudo.trim() })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /knowledge-base/:id  { titulo?, conteudo?, ativo? }
router.patch('/:id', async (req, res) => {
  const { data: item } = await supabase.from('knowledge_base').select('doctor_id').eq('id', req.params.id).single();
  if (!item) return res.status(404).json({ error: 'Não encontrado' });
  if (!(await checarAcesso(req, item.doctor_id))) return res.status(403).json({ error: 'Sem acesso' });

  const { titulo, conteudo, ativo } = req.body;
  const campos = {};
  if (titulo !== undefined) campos.titulo = titulo;
  if (conteudo !== undefined) campos.conteudo = conteudo;
  if (ativo !== undefined) campos.ativo = ativo;

  const { data, error } = await supabase.from('knowledge_base').update(campos).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /knowledge-base/:id
router.delete('/:id', async (req, res) => {
  const { data: item } = await supabase.from('knowledge_base').select('doctor_id').eq('id', req.params.id).single();
  if (!item) return res.status(404).json({ error: 'Não encontrado' });
  if (!(await checarAcesso(req, item.doctor_id))) return res.status(403).json({ error: 'Sem acesso' });

  const { error } = await supabase.from('knowledge_base').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
