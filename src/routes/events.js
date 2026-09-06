import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds, isScopedToOwnLeadsOnly } from '../middleware/auth.js';
import { authorizeResource, assertRelatedBelongs, assertUserAccess } from '../lib/authz.js';
import { criarEventoNoGoogle, temConflito } from '../lib/googleCalendar.js';
import { logger } from '../lib/logger.js';
import { attachTenantContext, scopedDoctorIds } from '../lib/tenantContext.js';

const router = Router();
router.use(requireAuth);
router.use(attachTenantContext);

const createSchema = z
  .object({
    doctor_id: z.string().uuid(),
    lead_id: z.string().uuid().nullable().optional(),
    tipo: z.string().min(1).max(50),
    titulo: z.string().min(1).max(200),
    inicio: z.string().datetime(),
    fim: z.string().datetime().optional(),
    responsavel_id: z.string().uuid().optional(),
  })
  .strict();

const statusSchema = z
  .object({
    status: z.enum(['pendente', 'compareceu', 'faltou', 'cancelado']),
    valor: z.number().nonnegative().nullable().optional(),
  })
  .strict();

// GET /events?doctor_id=&from=&to=
// Lista os eventos do período (usado pra desenhar o mês/dia na Agenda).
router.get('/', async (req, res, next) => {
  try {
    const scopedIds = await scopedDoctorIds(req, getScopedDoctorIds);

    let query = supabase
      .from('events')
      .select('*, leads(nome, telefone, journey_type)')
      .order('inicio', { ascending: true });

    if (scopedIds) query = query.in('doctor_id', scopedIds);
    if (req.query.doctor_id) query = query.eq('doctor_id', req.query.doctor_id);
    if (req.query.from) query = query.gte('inicio', req.query.from);
    if (req.query.to) query = query.lte('inicio', req.query.to);

    // Closer só vê os próprios eventos, não a agenda toda do médico
    if (isScopedToOwnLeadsOnly(req.user)) {
      query = query.eq('responsavel_id', req.user.id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) {
    next(e);
  }
});

// POST /events — cria um evento novo (reunião ou consulta).
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
    const body = parsed.data;

    const scopedIds = await scopedDoctorIds(req, getScopedDoctorIds);
    if (scopedIds && !scopedIds.includes(body.doctor_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // lead_id e responsavel_id do body são fronteiras de tenant — validados no servidor.
    if (body.lead_id) {
      const rel = await assertRelatedBelongs({ table: 'leads', id: body.lead_id, doctorId: body.doctor_id });
      if (!rel.ok) return res.status(403).json({ error: 'related_resource_forbidden' });
    }

    const responsavelId = body.responsavel_id ?? req.user.id;
    if (req.user.role === 'closer' && responsavelId !== req.user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // O responsável tem que ter acesso à clínica. Admin de plataforma é exceção
    // (não pertence a nenhuma clínica) — mas então precisa informar um
    // responsavel_id explícito de alguém que pertence.
    if (req.user.role !== 'admin' || body.responsavel_id) {
      if (!(await assertUserAccess({ req, userId: responsavelId, doctorId: body.doctor_id }))) {
        return res.status(403).json({ error: 'related_resource_forbidden' });
      }
    }

    const fim = body.fim ?? new Date(new Date(body.inicio).getTime() + 3600000).toISOString();

    // Checa conflito na agenda da pessoa antes de criar — só avisa, não bloqueia.
    const conflito = await temConflito(responsavelId, body.inicio, fim);

    const { data, error } = await supabase
      .from('events')
      .insert({
        doctor_id: body.doctor_id,
        lead_id: body.lead_id ?? null,
        tipo: body.tipo,
        titulo: body.titulo,
        inicio: body.inicio,
        fim,
        responsavel_id: responsavelId,
        ...(req.tenant?.enabled && req.tenant.organizationId
          ? { organization_id: req.tenant.organizationId, unit_id: req.tenant.defaultUnitId ?? null }
          : {}),
      })
      .select('*, leads(nome, telefone, journey_type)')
      .single();
    if (error) throw error;

    // Espelha no Google Calendar da pessoa, se ela tiver conectado. Falha aqui
    // não derruba o evento — ele continua existindo no Prognexo.
    try {
      const { data: responsavel } = await supabase.from('users').select('nome').eq('id', responsavelId).single();
      const googleEventId = await criarEventoNoGoogle(responsavelId, responsavel?.nome ?? 'Usuário', {
        titulo: body.titulo,
        inicio: body.inicio,
        fim,
      });
      if (googleEventId) {
        await supabase.from('events').update({ google_event_id: googleEventId }).eq('id', data.id);
      }
    } catch (err) {
      logger.warn({ err }, 'Google Calendar sync failed');
    }

    res.status(201).json({ ...data, conflito });
  } catch (e) {
    next(e);
  }
});

// PATCH /events/:id/status — marca "compareceu" / "faltou".
// Quando compareceu, gera um registro em `atendimentos` (histórico de visita).
router.patch('/:id/status', async (req, res, next) => {
  try {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

    // Resolve o evento no servidor e confirma o acesso (closer só o próprio).
    const auth = await authorizeResource({
      req,
      table: 'events',
      id: req.params.id,
      requireOwnerForCloser: true,
    });
    if (!auth.ok) return res.status(auth.reason === 'not_found' ? 404 : 403).json({ error: auth.reason });

    const { data, error } = await supabase
      .from('events')
      .update({ status: parsed.data.status })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;

    if (parsed.data.status === 'compareceu' && data.lead_id) {
      const result = await supabase.from('atendimentos').insert({
        lead_id: data.lead_id,
        event_id: data.id,
        data: data.inicio,
        valor: parsed.data.valor ?? null,
        compareceu: true,
      });
      if (result.error) throw result.error;
    }

    res.json(data);
  } catch (e) {
    next(e);
  }
});

export default router;
