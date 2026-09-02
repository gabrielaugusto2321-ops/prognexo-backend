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

// PATCH /doctors/:id/ia — liga/desliga o atendimento por IA e salva
// contexto, nome do agente, guardrails e critérios de qualificação
router.patch('/:id/ia', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  if (scopedIds && !scopedIds.includes(req.params.id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const { ia_atendimento_ativo, ia_contexto, ia_nome_agente, ia_palavras_proibidas, ia_score_minimo, ia_criterios, ia_limite_mensagens } = req.body;
  const campos = {};
  if (ia_atendimento_ativo !== undefined) campos.ia_atendimento_ativo = ia_atendimento_ativo;
  if (ia_contexto !== undefined) campos.ia_contexto = ia_contexto;
  if (ia_nome_agente !== undefined) campos.ia_nome_agente = ia_nome_agente;
  if (ia_palavras_proibidas !== undefined) campos.ia_palavras_proibidas = ia_palavras_proibidas;
  if (ia_score_minimo !== undefined) campos.ia_score_minimo = ia_score_minimo;
  if (ia_criterios !== undefined) campos.ia_criterios = ia_criterios;
  if (ia_limite_mensagens !== undefined) campos.ia_limite_mensagens = ia_limite_mensagens;

  const { data, error } = await supabase
    .from('doctors')
    .update(campos)
    .eq('id', req.params.id)
    .select('id, ia_atendimento_ativo, ia_contexto, ia_nome_agente, ia_palavras_proibidas, ia_score_minimo, ia_criterios, ia_limite_mensagens')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export default router;
