import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds, isScopedToOwnLeadsOnly } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function formatarHora(timestamp) {
  if (!timestamp) return '';
  const data = new Date(timestamp);
  const hoje = new Date();
  const ontem = new Date(hoje);
  ontem.setDate(hoje.getDate() - 1);

  const mesmoDia = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const hora = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  if (mesmoDia(data, hoje)) return `Hoje, ${hora}`;
  if (mesmoDia(data, ontem)) return `Ontem, ${hora}`;
  return `${data.toLocaleDateString('pt-BR')}, ${hora}`;
}

function iniciais(nome) {
  if (!nome) return '';
  return nome.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
}

// GET /conversations?doctor_id=&lead_id=
// Timeline de mensagens (hoje só WhatsApp), agrupada por lead — mais recente primeiro.
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id, lead_id } = req.query;

  let query = supabase
    .from('conversations')
    .select(
      '*, leads!inner(id, nome, doctor_id, sdr_responsavel_id, doctors(nome), deals(products(nome)), sdr:users!leads_sdr_responsavel_id_fkey(nome))'
    )
    .order('timestamp_msg', { ascending: false })
    .limit(300);

  if (lead_id) query = query.eq('lead_id', lead_id);
  if (doctor_id) query = query.eq('leads.doctor_id', doctor_id);
  else if (scopedIds) query = query.in('leads.doctor_id', scopedIds);

  // Closer só vê conversas dos próprios leads
  if (isScopedToOwnLeadsOnly(req.user)) {
    query = query.eq('leads.sdr_responsavel_id', req.user.id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Agrupa as linhas por lead, na ordem em que o lead mais recente apareceu primeiro
  const gruposPorLead = new Map();
  for (const row of data) {
    const lead = row.leads;
    if (!gruposPorLead.has(lead.id)) {
      gruposPorLead.set(lead.id, {
        lead: lead.nome,
        doctor: lead.doctors?.nome ?? '',
        produto: lead.deals?.[0]?.products?.nome ?? '',
        mensagens: [],
      });
    }
    gruposPorLead.get(lead.id).mensagens.push({
      direcao: row.direcao,
      texto: row.conteudo,
      origem: row.origem,
      sdr: row.origem === 'manual' ? iniciais(lead.sdr?.nome) : undefined,
      hora: formatarHora(row.timestamp_msg),
    });
  }

  // Mensagens dentro de cada grupo em ordem cronológica (mais antiga primeiro)
  const grupos = Array.from(gruposPorLead.values()).map((g) => ({
    ...g,
    mensagens: g.mensagens.slice().reverse(),
  }));

  res.json(grupos);
});

export default router;
