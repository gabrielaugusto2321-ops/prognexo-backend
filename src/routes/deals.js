import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds, isScopedToOwnLeadsOnly } from '../middleware/auth.js';
import { authorizeResource } from '../lib/authz.js';
import { attachTenantContext, scopedDoctorIds } from '../lib/tenantContext.js';

const router = Router();
router.use(requireAuth);
router.use(attachTenantContext);

const etapaSchema = z
  .object({
    etapa: z.enum(['lead', 'conversa_iniciada', 'reuniao_marcada', 'proposta', 'fechado', 'perdido']),
    motivo_perda: z.string().max(500).nullable().optional(),
  })
  .strict();

function iniciais(nome) {
  if (!nome) return '';
  return nome
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

// GET /deals?doctor_id= — retorna deals agrupáveis por etapa no frontend (kanban)
router.get('/', async (req, res, next) => {
  try {
    const scopedIds = await scopedDoctorIds(req, getScopedDoctorIds);
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
    if (error) throw error;

    // Achata os campos aninhados no formato que o card do kanban espera
    const achatados = (data || []).map((deal) => ({
      ...deal,
      lead_nome: deal.leads?.nome ?? '',
      produto: deal.products?.nome ?? '',
      tipo: deal.leads?.journey_type ?? 'low_ticket',
      sdr: iniciais(deal.sdr?.nome),
    }));

    res.json(achatados);
  } catch (e) {
    next(e);
  }
});

// PATCH /deals/:id/etapa — mover o card no kanban
router.patch('/:id/etapa', async (req, res, next) => {
  try {
    const parsed = etapaSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

    // Resolve o deal no servidor (dono = médico do lead) e confirma o acesso —
    // closer só move card onde é o responsável.
    const auth = await authorizeResource({
      req,
      table: 'deals',
      id: req.params.id,
      ownerPath: 'leads.doctor_id',
      requireOwnerForCloser: true,
      select: '*, leads(id, doctor_id)',
    });
    if (!auth.ok) return res.status(auth.reason === 'not_found' ? 404 : 403).json({ error: auth.reason });

    const { data, error } = await supabase
      .from('deals')
      .update({ etapa: parsed.data.etapa, motivo_perda: parsed.data.motivo_perda ?? null })
      .eq('id', req.params.id)
      .select('*, leads(id)')
      .single();
    if (error) throw error;

    // Mantém o status do lead sincronizado com a etapa do deal
    const sync = await supabase.from('leads').update({ status_atual: parsed.data.etapa }).eq('id', data.leads.id);
    if (sync.error) throw sync.error;

    res.json(data);
  } catch (e) {
    next(e);
  }
});

export default router;
