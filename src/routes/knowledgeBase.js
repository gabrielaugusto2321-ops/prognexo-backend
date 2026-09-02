import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';
import { reindexarKnowledgeBaseItem } from '../lib/knowledgeChunks.js';

const router = Router();
router.use(requireAuth);

async function checarAcesso(req, doctorId) {
  const scopedIds = await getScopedDoctorIds(req.user);
  return !scopedIds || scopedIds.includes(doctorId);
}

// Gera os embeddings do item (ingestão inline). Se a Voyage falhar, o
// item já foi salvo — devolve o erro num campo à parte em vez de derrubar
// a request inteira, e o backfill/edição posterior refazem a indexação.
async function reindexarComTolerancia(item) {
  try {
    await reindexarKnowledgeBaseItem(item);
    return null;
  } catch (err) {
    console.error('Erro ao indexar item da base de conhecimento:', err);
    return err.message;
  }
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

  const erroIndexacao = await reindexarComTolerancia(data);
  res.json(erroIndexacao ? { ...data, erro_indexacao: erroIndexacao } : data);
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

  // Só refaz embeddings se o texto mudou; alternar "ativo" não precisa,
  // porque a RPC de busca já filtra por knowledge_base.ativo.
  if (titulo !== undefined || conteudo !== undefined) {
    const erroIndexacao = await reindexarComTolerancia(data);
    return res.json(erroIndexacao ? { ...data, erro_indexacao: erroIndexacao } : data);
  }
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
