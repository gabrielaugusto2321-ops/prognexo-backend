import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /reports?doctor_id=&periodo_dias=30
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id, periodo_dias = 30 } = req.query;
  const dias = Number(periodo_dias);

  if (doctor_id && scopedIds && !scopedIds.includes(doctor_id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const agora = new Date();
  const desde = new Date(agora.getTime() - dias * 86400000).toISOString();
  const desdeAnterior = new Date(agora.getTime() - dias * 2 * 86400000).toISOString();

  // --- Deals fechados (receita + ranking) ---
  let dealsQuery = supabase
    .from('deals')
    .select('valor, etapa, sdr_responsavel_id, atualizado_em, leads!inner(doctor_id)')
    .eq('etapa', 'fechado');

  if (doctor_id) dealsQuery = dealsQuery.eq('leads.doctor_id', doctor_id);
  else if (scopedIds) dealsQuery = dealsQuery.in('leads.doctor_id', scopedIds);

  const { data: dealsFechados } = await dealsQuery;

  const dealsPeriodoAtual = (dealsFechados || []).filter((d) => d.atualizado_em >= desde);
  const dealsPeriodoAnterior = (dealsFechados || []).filter((d) => d.atualizado_em >= desdeAnterior && d.atualizado_em < desde);

  const receitaAtual = dealsPeriodoAtual.reduce((soma, d) => soma + Number(d.valor || 0), 0);
  const receitaAnterior = dealsPeriodoAnterior.reduce((soma, d) => soma + Number(d.valor || 0), 0);
  const variacaoReceita = receitaAnterior > 0 ? Math.round(((receitaAtual - receitaAnterior) / receitaAnterior) * 100) : null;

  // Ranking de closers por valor fechado no período
  const totalPorCloser = {};
  for (const d of dealsPeriodoAtual) {
    if (!d.sdr_responsavel_id) continue;
    totalPorCloser[d.sdr_responsavel_id] = (totalPorCloser[d.sdr_responsavel_id] || 0) + Number(d.valor || 0);
  }
  const closerIds = Object.keys(totalPorCloser);
  let ranking = [];
  if (closerIds.length > 0) {
    const { data: closers } = await supabase.from('users').select('id, nome').in('id', closerIds);
    ranking = (closers || [])
      .map((c) => ({ nome: c.nome, valor: totalPorCloser[c.id] }))
      .sort((a, b) => b.valor - a.valor);
  }

  // --- Comparecimento em reunião (módulo Vendas) ---
  let eventosVendaQuery = supabase
    .from('events')
    .select('status, doctor_id')
    .eq('tipo', 'venda')
    .in('status', ['compareceu', 'faltou'])
    .gte('inicio', desde);

  if (doctor_id) eventosVendaQuery = eventosVendaQuery.eq('doctor_id', doctor_id);
  else if (scopedIds) eventosVendaQuery = eventosVendaQuery.in('doctor_id', scopedIds);

  const { data: eventosVenda } = await eventosVendaQuery;
  const totalReunioes = (eventosVenda || []).length;
  const compareceuReuniao = (eventosVenda || []).filter((e) => e.status === 'compareceu').length;
  const taxaComparecimentoReuniao = totalReunioes > 0 ? Math.round((compareceuReuniao / totalReunioes) * 100) : null;

  // --- Módulo Pacientes ---
  let atendimentosQuery = supabase
    .from('atendimentos')
    .select('valor, compareceu, lead_id, data, leads!inner(doctor_id)')
    .gte('data', desde);

  if (doctor_id) atendimentosQuery = atendimentosQuery.eq('leads.doctor_id', doctor_id);
  else if (scopedIds) atendimentosQuery = atendimentosQuery.in('leads.doctor_id', scopedIds);

  const { data: atendimentos } = await atendimentosQuery;
  const totalAtendimentos = (atendimentos || []).length;
  const valoresValidos = (atendimentos || []).map((a) => Number(a.valor)).filter((v) => !isNaN(v) && v > 0);
  const ticketMedio = valoresValidos.length > 0 ? Math.round(valoresValidos.reduce((s, v) => s + v, 0) / valoresValidos.length) : 0;

  // Taxa de retorno: % de pacientes (leads) com mais de 1 atendimento no período
  const contagemPorPaciente = {};
  for (const a of atendimentos || []) {
    contagemPorPaciente[a.lead_id] = (contagemPorPaciente[a.lead_id] || 0) + 1;
  }
  const totalPacientesUnicos = Object.keys(contagemPorPaciente).length;
  const pacientesComRetorno = Object.values(contagemPorPaciente).filter((c) => c > 1).length;
  const taxaRetorno = totalPacientesUnicos > 0 ? Math.round((pacientesComRetorno / totalPacientesUnicos) * 100) : null;

  // No-show: % de consultas (eventos tipo paciente) marcadas como faltou
  let eventosPacienteQuery = supabase
    .from('events')
    .select('status, doctor_id')
    .eq('tipo', 'paciente')
    .in('status', ['compareceu', 'faltou'])
    .gte('inicio', desde);

  if (doctor_id) eventosPacienteQuery = eventosPacienteQuery.eq('doctor_id', doctor_id);
  else if (scopedIds) eventosPacienteQuery = eventosPacienteQuery.in('doctor_id', scopedIds);

  const { data: eventosPaciente } = await eventosPacienteQuery;
  const totalConsultas = (eventosPaciente || []).length;
  const faltas = (eventosPaciente || []).filter((e) => e.status === 'faltou').length;
  const noShow = totalConsultas > 0 ? Math.round((faltas / totalConsultas) * 100) : null;

  res.json({
    periodo_dias: dias,
    receita_atual: receitaAtual,
    receita_anterior: receitaAnterior,
    variacao_receita_pct: variacaoReceita,
    taxa_comparecimento_reuniao: taxaComparecimentoReuniao,
    ranking_closers: ranking,
    pacientes: {
      taxa_retorno: taxaRetorno,
      ticket_medio: ticketMedio,
      no_show: noShow,
      total_atendimentos: totalAtendimentos,
    },
  });
});

export default router;
