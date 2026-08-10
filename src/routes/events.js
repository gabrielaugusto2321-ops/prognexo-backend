import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds, isScopedToOwnLeadsOnly } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /events?doctor_id=&from=&to=
// Lista os eventos do período (usado pra desenhar o mês/dia na Agenda)
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id, from, to } = req.query;

  let query = supabase
    .from('events')
    .select('*, leads(nome, telefone, journey_type)')
    .order('inicio', { ascending: true });

  if (scopedIds) query = query.in('doctor_id', scopedIds);
  if (doctor_id) query = query.eq('doctor_id', doctor_id);
  if (from) query = query.gte('inicio', from);
  if (to) query = query.lte('inicio', to);

  // Closer só vê os próprios eventos, não a agenda toda do médico
  if (isScopedToOwnLeadsOnly(req.user)) {
    query = query.eq('responsavel_id', req.user.id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /events — cria um evento novo (reunião ou consulta)
router.post('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const payload = req.body;

  if (scopedIds && !scopedIds.includes(payload.doctor_id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const { data, error } = await supabase
    .from('events')
    .insert({
      doctor_id: payload.doctor_id,
      lead_id: payload.lead_id ?? null,
      tipo: payload.tipo,
      titulo: payload.titulo,
      inicio: payload.inicio,
      fim: payload.fim ?? null,
      responsavel_id: payload.responsavel_id ?? req.user.id,
    })
    .select('*, leads(nome, telefone, journey_type)')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /events/:id/status — marca "compareceu" ou "faltou"
// Quando compareceu, gera automaticamente um registro em `atendimentos`
// (histórico de visita), que alimenta o módulo Pacientes depois.
router.patch('/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, valor } = req.body;

  if (!['pendente', 'compareceu', 'faltou', 'cancelado'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido' });
  }

  const { data: evento, error } = await supabase
    .from('events')
    .update({ status })
    .eq('id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (status === 'compareceu' && evento.lead_id) {
    await supabase.from('atendimentos').insert({
      lead_id: evento.lead_id,
      event_id: evento.id,
      data: evento.inicio,
      valor: valor ?? null,
      compareceu: true,
    });
  }

  res.json(evento);
});

export default router;
