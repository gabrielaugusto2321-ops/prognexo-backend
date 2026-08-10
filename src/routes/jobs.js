import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// POST /jobs/limpar-leads-esquecidos?secret=TOKEN
// NÃO exige login — é chamada por um serviço externo de cron (cron-job.org,
// grátis), não por uma pessoa logada. A segurança vem do secret na URL.
//
// Regra: lead parado em "lead" ou "conversa_iniciada" há mais de 7 dias
// sem nenhuma mensagem nova vira "perdido" sozinho — evita funil lotado
// de lead fantasma que ninguém vai mais responder.
router.post('/limpar-leads-esquecidos', async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const seteDiasAtras = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // Busca candidatos: ainda em etapa aberta, criados há mais de 7 dias
  const { data: candidatos, error } = await supabase
    .from('leads')
    .select('id, criado_em')
    .in('status_atual', ['lead', 'conversa_iniciada'])
    .lt('criado_em', seteDiasAtras);

  if (error) return res.status(500).json({ error: error.message });
  if (!candidatos || candidatos.length === 0) {
    return res.json({ marcados_como_perdido: 0 });
  }

  const candidatoIds = candidatos.map((c) => c.id);

  // Confirma que também não teve mensagem recente (só criado_em não basta,
  // o lead pode ter respondido depois de muito tempo)
  const { data: conversasRecentes } = await supabase
    .from('conversations')
    .select('lead_id')
    .in('lead_id', candidatoIds)
    .gte('timestamp_msg', seteDiasAtras);

  const idsComConversaRecente = new Set((conversasRecentes || []).map((c) => c.lead_id));
  const idsParaMarcar = candidatoIds.filter((id) => !idsComConversaRecente.has(id));

  if (idsParaMarcar.length === 0) {
    return res.json({ marcados_como_perdido: 0 });
  }

  await supabase.from('leads').update({ status_atual: 'perdido' }).in('id', idsParaMarcar);
  await supabase.from('deals').update({ etapa: 'perdido', motivo_perda: 'Sem resposta há mais de 7 dias' }).in('lead_id', idsParaMarcar);

  res.json({ marcados_como_perdido: idsParaMarcar.length });
});

export default router;
