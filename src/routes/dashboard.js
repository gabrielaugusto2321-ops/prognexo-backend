import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /dashboard?doctor_id=&periodo_dias=30
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id, periodo_dias = 30 } = req.query;
  const desde = new Date(Date.now() - periodo_dias * 86400000).toISOString();

  let leadsQuery = supabase.from('leads').select('id, journey_type, status_atual, criado_em').gte('criado_em', desde);
  if (doctor_id) leadsQuery = leadsQuery.eq('doctor_id', doctor_id);
  else if (scopedIds) leadsQuery = leadsQuery.in('doctor_id', scopedIds);

  const { data: leads, error } = await leadsQuery;
  if (error) return res.status(500).json({ error: error.message });

  const totalLeads = leads.length;
  const conversasIniciadas = leads.filter((l) => l.status_atual !== 'lead').length;
  const fechados = leads.filter((l) => l.status_atual === 'fechado').length;

  let transQuery = supabase
    .from('transactions')
    .select('valor, status, criado_em')
    .eq('status', 'pago')
    .gte('criado_em', desde);

  const { data: transacoes } = await transQuery;
  const receita = (transacoes || []).reduce((sum, t) => sum + Number(t.valor), 0);

  res.json({
    periodo_dias: Number(periodo_dias),
    total_leads: totalLeads,
    conversas_iniciadas: conversasIniciadas,
    taxa_resposta: totalLeads ? Math.round((conversasIniciadas / totalLeads) * 100) : 0,
    fechamentos: fechados,
    receita_gerada: receita,
  });
});

export default router;
