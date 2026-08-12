import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds, isScopedToOwnLeadsOnly } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function iniciais(nome) {
  if (!nome) return '';
  return nome.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
}

// GET /deals?doctor_id= — retorna deals agrupáveis por etapa no frontend (kanban)
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id } = req.query;

  let query = supabase
    .from('deals')
    .select(
      '*, leads!inner(id, nome, doctor_id, journey_type), products(nome, preco), sdr:users!deals_sdr_responsavel_id_fkey(nome)'
    )
    .order('atualizado_em', { ascending: false });

  if (doctor_id) query = query.eq('leads.doctor_id', doctor_id);
  else if (scopedIds) query = query.in('leads.doctor_id', scopedIds);

  // Closer só vê o próprio pipeline — não o do médico inteiro
  if (isScopedToOwnLeadsOnly(req.user)) {
    query = query.eq('sdr_responsavel_id', req.user.id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Achata os campos aninhados no formato que o card do kanban espera
  const achatados = data.map((deal) => ({
    ...deal,
    lead_nome: deal.leads?.nome ?? '',
    produto: deal.products?.nome ?? '',
    tipo: deal.leads?.journey_type ?? 'low_ticket',
    sdr: iniciais(deal.sdr?.nome),
  }));

  res.json(achatados);
});

// PATCH /deals/:id/etapa — mover o card no kanban
router.patch('/:id/etapa', async (req, res) => {
  const { id } = req.params;
  const { etapa, motivo_perda } = req.body;

  const etapasValidas = ['lead', 'conversa_iniciada', 'reuniao_marcada', 'proposta', 'fechado', 'perdido'];
  if (!etapasValidas.includes(etapa)) {
    return res.status(400).json({ error: 'Etapa inválida' });
  }

  // Closer só pode mover cards que são dele
  let query = supabase.from('deals').update({ etapa, motivo_perda: motivo_perda ?? null }).eq('id', id);
  if (isScopedToOwnLeadsOnly(req.user)) {
    query = query.eq('sdr_responsavel_id', req.user.id);
  }

  const { data, error } = await query.select('*, leads(id)').single();
  if (error) return res.status(500).json({ error: error.message });

  // Mantém o status do lead sincronizado com a etapa do deal
  await supabase.from('leads').update({ status_atual: etapa }).eq('id', data.leads.id);

  res.json(data);
});

export default router;
