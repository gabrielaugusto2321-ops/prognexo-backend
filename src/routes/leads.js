import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds, isScopedToOwnLeadsOnly } from '../middleware/auth.js';
import { authorizeResource, assertRelatedBelongs, assertUserAccess } from '../lib/authz.js';
import { escolherCloserAutomatico } from '../lib/distribuicao.js';
import { attachTenantContext, scopedDoctorIds } from '../lib/tenantContext.js';

const router = Router();
router.use(requireAuth);
router.use(attachTenantContext); // FASE 2.1 — no-op se TENANT_CORE_ENABLED=false

// O cliente nunca envia req.body cru. O tenant (doctor_id) ainda vem no body
// por compatibilidade com o modelo atual, mas é sempre validado contra
// getScopedDoctorIds — nunca é fonte de autoridade.
const createSchema = z
  .object({
    doctor_id: z.string().uuid(),
    nome: z.string().trim().min(1).max(160),
    telefone: z.string().max(30).optional(),
    email: z.string().email().optional(),
    journey_type: z.enum(['low_ticket', 'high_ticket']).optional(),
    status_atual: z.string().max(50).optional(),
    product_id: z.string().uuid().nullable().optional(),
    sdr_responsavel_id: z.string().uuid().nullable().optional(),
    dados_extraidos: z.record(z.unknown()).optional(),
  })
  .strict();

const updateSchema = z
  .object({
    status_atual: z.string().max(50).optional(),
    dados_extraidos: z.record(z.unknown()).optional(),
    nome: z.string().trim().min(1).max(160).optional(),
    telefone: z.string().max(30).optional(),
    email: z.string().email().nullable().optional(),
    journey_type: z.enum(['low_ticket', 'high_ticket']).optional(),
    sdr_responsavel_id: z.string().uuid().nullable().optional(),
    atendido_por: z.enum(['humano', 'ia']).optional(),
  })
  .strict();

// GET /leads?doctor_id=&journey_type=&status=
router.get('/', async (req, res, next) => {
  try {
    const scopedIds = await scopedDoctorIds(req, getScopedDoctorIds);
    const { doctor_id, journey_type, status } = req.query;

    let query = supabase.from('leads').select('*').order('criado_em', { ascending: false });

    if (scopedIds) query = query.in('doctor_id', scopedIds);
    if (doctor_id) query = query.eq('doctor_id', doctor_id);
    if (journey_type) query = query.eq('journey_type', journey_type);
    if (status) query = query.eq('status_atual', status);

    // Closer só vê a própria carteira — não o funil inteiro do médico
    if (isScopedToOwnLeadsOnly(req.user)) {
      query = query.eq('sdr_responsavel_id', req.user.id);
    }

    const { data: leads, error } = await query;
    if (error) throw error;

    // Calcula há quanto tempo cada lead está sem interação, pra sinalizar
    // "esfriando" sem precisar de nenhum job separado — é só matemática em cima
    // da última conversa registrada (ou da criação do lead, se nunca respondeu).
    const leadIds = (leads || []).map((l) => l.id);
    const ultimaInteracaoPorLead = {};

    if (leadIds.length > 0) {
      const { data: conversas } = await supabase
        .from('conversations')
        .select('lead_id, timestamp_msg')
        .in('lead_id', leadIds)
        .order('timestamp_msg', { ascending: false });

      for (const c of conversas || []) {
        if (!ultimaInteracaoPorLead[c.lead_id]) ultimaInteracaoPorLead[c.lead_id] = c.timestamp_msg;
      }
    }

    const agora = Date.now();
    const enriquecidos = (leads || []).map((lead) => {
      const referencia = ultimaInteracaoPorLead[lead.id] ?? lead.criado_em;
      const horasSemInteracao = Math.round((agora - new Date(referencia).getTime()) / 3600000);
      const etapaAberta = ['lead', 'conversa_iniciada'].includes(lead.status_atual);
      return {
        ...lead,
        horas_sem_interacao: horasSemInteracao,
        esfriando: etapaAberta && horasSemInteracao >= 4,
      };
    });

    res.json(enriquecidos);
  } catch (e) {
    next(e);
  }
});

// POST /leads — criação manual ou via integração externa (quiz, formulário)
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
    const body = parsed.data;

    const scopedIds = await scopedDoctorIds(req, getScopedDoctorIds);
    if (scopedIds && !scopedIds.includes(body.doctor_id)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // FASE 2.1: quando o tenant core está ligado, grava organization_id derivada
    // do contexto (nunca do body) e exige que o doctor_id do body case com o map.
    const orgId = req.tenant?.enabled ? req.tenant.organizationId : undefined;
    if (req.tenant?.enabled && req.tenant.doctorId && body.doctor_id !== req.tenant.doctorId) {
      return res.status(403).json({ error: 'doctor_org_mismatch' });
    }

    // Todo id relacionado é fronteira de tenant: o produto tem que ser do mesmo médico.
    if (body.product_id) {
      const rel = await assertRelatedBelongs({ table: 'products', id: body.product_id, doctorId: body.doctor_id });
      if (!rel.ok) return res.status(403).json({ error: 'related_resource_forbidden' });
    }

    // Responsável: closer só pode atribuir a si mesmo; doctor/admin a qualquer
    // usuário com acesso ao médico. Sem responsável, cai na distribuição automática.
    let owner = body.sdr_responsavel_id ?? null;
    if (req.user.role === 'closer') {
      if (owner && owner !== req.user.id) return res.status(403).json({ error: 'forbidden' });
      owner = req.user.id;
    } else if (owner && !(await assertUserAccess({ userId: owner, doctorId: body.doctor_id }))) {
      return res.status(403).json({ error: 'related_resource_forbidden' });
    }
    if (!owner) owner = await escolherCloserAutomatico(body.doctor_id);

    const { data, error } = await supabase
      .from('leads')
      .insert({ ...body, sdr_responsavel_id: owner || null, ...(orgId ? { organization_id: orgId } : {}) })
      .select()
      .single();
    if (error) throw error;

    // Cria automaticamente o deal correspondente na etapa "lead"
    const dealResult = await supabase.from('deals').insert({
      lead_id: data.id,
      product_id: body.product_id ?? null,
      etapa: 'lead',
      sdr_responsavel_id: owner || null,
    });
    if (dealResult.error) throw dealResult.error;

    res.status(201).json(data);
  } catch (e) {
    next(e);
  }
});

// PATCH /leads/:id — atualizar status manualmente, ou reatribuir o closer responsável
router.patch('/:id', async (req, res, next) => {
  try {
    // Resolve o lead no servidor e confirma o acesso do usuário — nunca confia no :id sozinho.
    const auth = await authorizeResource({
      user: req.user,
      table: 'leads',
      id: req.params.id,
      requireOwnerForCloser: true,
    });
    if (!auth.ok) return res.status(auth.reason === 'not_found' ? 404 : 403).json({ error: auth.reason });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

    // Closer não pode reatribuir responsável
    if (req.user.role === 'closer' && 'sdr_responsavel_id' in parsed.data) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (
      parsed.data.sdr_responsavel_id &&
      !(await assertUserAccess({ userId: parsed.data.sdr_responsavel_id, doctorId: auth.row.doctor_id }))
    ) {
      return res.status(403).json({ error: 'related_resource_forbidden' });
    }

    const { data, error } = await supabase
      .from('leads')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    next(e);
  }
});

export default router;
