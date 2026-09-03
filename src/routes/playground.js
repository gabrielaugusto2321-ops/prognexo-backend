import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';
import { processarMensagemComIA } from '../lib/iaAgent.js';
import { buscarChunksRelevantes } from '../lib/knowledgeChunks.js';
import { AI_LIMITS, checkHistoryLimits, tryAcquireAiSlot } from '../lib/aiLimits.js';
import { logger } from '../lib/logger.js';

const router = Router();
router.use(requireAuth);

const schema = z
  .object({
    doctor_id: z.string().uuid(),
    historico: z
      .array(
        z
          .object({
            direcao: z.enum(['recebida', 'enviada']),
            conteudo: z.string().max(AI_LIMITS.MAX_MESSAGE_CHARS),
          })
          .strip()
      )
      .min(1)
      .max(AI_LIMITS.MAX_HISTORY_MESSAGES),
    contexto_produto: z.string().max(AI_LIMITS.MAX_PRODUCT_CONTEXT_CHARS).nullable().optional(),
  })
  .strip();

// POST /playground/simular
// Testa o agente de IA com a configuração REAL do médico, sem tocar em lead,
// conversa ou WhatsApp. Todos os limites são checados ANTES da chamada externa.
router.post('/simular', async (req, res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  const { doctor_id, historico, contexto_produto } = parsed.data;

  const limitCheck = checkHistoryLimits(historico, contexto_produto ?? undefined);
  if (!limitCheck.ok) return res.status(413).json({ error: limitCheck.reason });

  const scopedIds = await getScopedDoctorIds(req.user);
  if (scopedIds && !scopedIds.includes(doctor_id)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const release = tryAcquireAiSlot(doctor_id);
  if (!release) return res.status(429).json({ error: 'ai_busy' });

  try {
    const { data: doctor, error } = await supabase
      .from('doctors')
      .select('ia_nome_agente, ia_contexto, ia_palavras_proibidas, ia_score_minimo, ia_criterios')
      .eq('id', doctor_id)
      .single();
    if (error || !doctor) return res.status(404).json({ error: 'not_found' });

    // Mesma busca vetorial do webhook real: embeda a última mensagem do lead.
    const ultimaDoLead = [...historico].reverse().find((h) => h.direcao === 'recebida');
    let baseConhecimento = [];
    try {
      baseConhecimento = await buscarChunksRelevantes({ doctorId: doctor_id, pergunta: ultimaDoLead?.conteudo || '' });
    } catch (err) {
      logger.warn({ err }, 'Knowledge search failed (playground)');
    }

    const resultado = await processarMensagemComIA({
      nomeAgente: doctor.ia_nome_agente,
      contextoDoMedico: doctor.ia_contexto,
      contextoDoProduto: contexto_produto || null,
      baseConhecimento: baseConhecimento || [],
      palavrasProibidas: doctor.ia_palavras_proibidas,
      criterios: doctor.ia_criterios,
      scoreMinimo: doctor.ia_score_minimo,
      historico,
    });

    logger.info({ doctorId: doctor_id, historyLen: historico.length }, 'Playground simulation');
    res.json(resultado);
  } catch (err) {
    next(err);
  } finally {
    release();
  }
});

export default router;
