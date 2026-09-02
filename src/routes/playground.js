import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';
import { processarMensagemComIA } from '../lib/iaAgent.js';

const router = Router();
router.use(requireAuth);

// POST /playground/simular
// Testa o agente de IA com a configuração REAL e salva do médico (contexto,
// critérios, score mínimo, guardrails), mas sem tocar em lead, conversa ou
// WhatsApp de verdade — puro simulador, nada é persistido além do teste em si.
router.post('/simular', async (req, res) => {
  const { doctor_id, historico } = req.body;
  if (!doctor_id || !Array.isArray(historico) || historico.length === 0) {
    return res.status(400).json({ error: 'doctor_id e historico (array) são obrigatórios' });
  }

  const scopedIds = await getScopedDoctorIds(req.user);
  if (scopedIds && !scopedIds.includes(doctor_id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const { data: doctor, error } = await supabase
    .from('doctors')
    .select('ia_nome_agente, ia_contexto, ia_palavras_proibidas, ia_score_minimo, ia_criterios')
    .eq('id', doctor_id)
    .single();

  if (error || !doctor) return res.status(404).json({ error: 'Médico não encontrado' });

  const { data: baseConhecimento } = await supabase
    .from('knowledge_base')
    .select('titulo, conteudo')
    .eq('doctor_id', doctor_id)
    .eq('ativo', true);

  try {
    const resultado = await processarMensagemComIA({
      nomeAgente: doctor.ia_nome_agente,
      contextoDoMedico: doctor.ia_contexto,
      contextoDoProduto: req.body.contexto_produto || null,
      baseConhecimento: baseConhecimento || [],
      palavrasProibidas: doctor.ia_palavras_proibidas,
      criterios: doctor.ia_criterios,
      scoreMinimo: doctor.ia_score_minimo,
      historico,
    });
    res.json(resultado);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
