import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /patients?doctor_id=
// Um "paciente" é qualquer lead que já teve pelo menos 1 atendimento
// registrado (via "Compareceu" na Agenda). Calcula os tiers de reativação
// (ativo/esfriando/sumiu) direto em cima do histórico, sem precisar de
// nenhuma tabela nova.
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id } = req.query;

  if (doctor_id && scopedIds && !scopedIds.includes(doctor_id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  let query = supabase
    .from('atendimentos')
    .select('lead_id, valor, data, leads!inner(id, nome, telefone, doctor_id)');

  if (doctor_id) query = query.eq('leads.doctor_id', doctor_id);
  else if (scopedIds) query = query.in('leads.doctor_id', scopedIds);

  const { data: atendimentos, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Agrupa por paciente
  const porPaciente = {};
  for (const a of atendimentos || []) {
    if (!porPaciente[a.lead_id]) {
      porPaciente[a.lead_id] = {
        id: a.lead_id,
        nome: a.leads.nome,
        telefone: a.leads.telefone,
        visitas: [],
      };
    }
    porPaciente[a.lead_id].visitas.push({ valor: Number(a.valor) || 0, data: a.data });
  }

  const agora = Date.now();
  const pacientes = Object.values(porPaciente).map((p) => {
    const ultimaVisita = p.visitas.reduce((max, v) => (v.data > max ? v.data : max), p.visitas[0].data);
    const diasSemVisita = Math.floor((agora - new Date(ultimaVisita).getTime()) / 86400000);
    const valoresValidos = p.visitas.map((v) => v.valor).filter((v) => v > 0);
    const ticketMedio = valoresValidos.length > 0 ? Math.round(valoresValidos.reduce((s, v) => s + v, 0) / valoresValidos.length) : 0;

    let tier = 'ativo';
    if (diasSemVisita >= 90) tier = 'sumiu';
    else if (diasSemVisita >= 30) tier = 'esfriando';

    return {
      id: p.id,
      nome: p.nome,
      telefone: p.telefone,
      ultima_visita: ultimaVisita,
      dias_sem_visita: diasSemVisita,
      ticket_medio: ticketMedio,
      total_visitas: p.visitas.length,
      tier,
    };
  });

  pacientes.sort((a, b) => b.dias_sem_visita - a.dias_sem_visita);

  res.json(pacientes);
});

export default router;
