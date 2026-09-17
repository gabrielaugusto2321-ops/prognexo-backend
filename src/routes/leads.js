import express, { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds, isScopedToOwnLeadsOnly } from '../middleware/auth.js';
import { authorizeResource, assertRelatedBelongs, assertUserAccess } from '../lib/authz.js';
import { escolherCloserAutomatico } from '../lib/distribuicao.js';
import { attachTenantContext, scopedDoctorIds, tenantAllowsDoctor } from '../lib/tenantContext.js';
import { processImportFile, sha256Hex, MAX_BYTES } from '../lib/leadImport.js';

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
    } else if (owner && !(await assertUserAccess({ req, userId: owner, doctorId: body.doctor_id }))) {
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

const csvBodyParser = express.text({ type: 'text/csv', limit: '2mb' });
const parseCsvBody = (req, res, next) => csvBodyParser(req, res, (err) => {
  if (err?.type === 'entity.too.large') return res.status(400).json({ error: 'arquivo_muito_grande' });
  return err ? next(err) : next();
});

async function importDoctor(req, res) {
  if (!['admin', 'doctor'].includes(req.user?.role)) {
    res.status(403).json({ error: 'import_not_allowed_for_role' });
    return null;
  }
  const doctorId = typeof req.query.doctor_id === 'string' ? req.query.doctor_id : '';
  if (!z.string().uuid().safeParse(doctorId).success) {
    res.status(400).json({ error: 'doctor_id_invalido' });
    return null;
  }
  if (!(await tenantAllowsDoctor(req, doctorId, getScopedDoctorIds))) {
    res.status(403).json({ error: 'doctor_out_of_scope' });
    return null;
  }
  return doctorId;
}

function ensureCsv(req, res) {
  if (!req.is('text/csv')) { res.status(400).json({ error: 'content_type_invalido' }); return false; }
  if (typeof req.body !== 'string' || !req.body.trim()) { res.status(400).json({ error: 'arquivo_vazio' }); return false; }
  if (Buffer.byteLength(req.body, 'utf8') > MAX_BYTES) { res.status(400).json({ error: 'arquivo_muito_grande' }); return false; }
  return true;
}

async function processForDoctor(rawBody, doctorId) {
  return processImportFile(Buffer.from(rawBody, 'utf8'), {
    fetchExistingPhoneMap: async (phones) => {
      if (!phones.length) return new Map();
      const { data, error } = await supabase.from('leads').select('*')
        .eq('doctor_id', doctorId).in('telefone_normalizado', phones);
      if (error) throw error;
      return new Map((data || []).map((lead) => [lead.telefone_normalizado, lead.id]));
    },
  });
}

router.post('/import/preview', parseCsvBody, async (req, res, next) => {
  try {
    if (!ensureCsv(req, res)) return;
    const doctorId = await importDoctor(req, res);
    if (!doctorId) return;
    const result = await processForDoctor(req.body, doctorId);
    if (result.error) return res.status(400).json({ error: result.error, missing: result.missing, unexpected: result.extra });
    res.json(result);
  } catch (err) { next(err); }
});

// 15 minutos documentados (correção da FASE 1, item 19): um lote parado em
// 'processando' por mais tempo que isso é considerado órfão (processo
// reiniciou/caiu no meio) e pode ser retomado por uma nova tentativa.
const STALE_IMPORT_MS = 15 * 60 * 1000;

function isStaleProcessing(importRow) {
  return Date.now() - new Date(importRow.criado_em).getTime() >= STALE_IMPORT_MS;
}

// Decide o que fazer com um lote (doctor_id, file_hash) que JÁ EXISTE —  seja
// por idempotência (reenvio do mesmo arquivo) ou por ter perdido a corrida de
// inserção para outra requisição concorrente idêntica. Devolve uma função que
// responde imediatamente (sem processar nada), ou `null` se a requisição deve
// prosseguir e RETOMAR o processamento (lote 'falhou', ou 'processando' órfão).
function decideForExistingImport(importRow) {
  if (importRow.status === 'concluido') {
    return (res) => res.json({ ...importRow, import_id: importRow.id, ja_processado: true });
  }
  if (importRow.status === 'processando' && !isStaleProcessing(importRow)) {
    return (res) => res.status(409).json({ error: 'import_in_progress', import_id: importRow.id });
  }
  return null;
}

router.post('/import/commit', parseCsvBody, async (req, res, next) => {
  try {
    if (!ensureCsv(req, res)) return;
    const doctorId = await importDoctor(req, res);
    if (!doctorId) return;
    const nomeLista = typeof req.query.nome_lista === 'string' ? req.query.nome_lista.trim() : '';
    const filename = typeof req.query.filename === 'string' ? req.query.filename.trim() : '';
    if (!nomeLista || !filename) return res.status(400).json({ error: 'metadados_importacao_invalidos' });

    const result = await processForDoctor(req.body, doctorId);
    if (result.error) return res.status(400).json({ error: result.error, missing: result.missing, unexpected: result.extra });

    // Achado #1 da auditoria da FASE 1: se alguma linha se tornaria
    // 'autorizado', o cliente precisa ter enviado a declaração explícita —
    // nunca basta o `created_by` do lote como evidência implícita.
    const algumaAutorizada = result.linhas.some(
      (l) => (l.status === 'valido' || l.status === 'duplicado_existente') && l.autorizacao_alvo === 'autorizado'
    );
    const declarado = req.get('X-WhatsApp-Consent-Declared') === 'true';
    if (algumaAutorizada && !declarado) {
      return res.status(400).json({ error: 'authorization_declaration_required' });
    }

    const fileHash = sha256Hex(Buffer.from(req.body, 'utf8'));
    const organizationId = req.tenant?.enabled ? req.tenant.organizationId : undefined;

    const { data: existing, error: existingErr } = await supabase.from('lead_imports').select('*')
      .eq('doctor_id', doctorId).eq('file_hash', fileHash).maybeSingle();
    if (existingErr) throw existingErr;

    let importRow;
    let resuming = false;

    if (existing) {
      const decision = decideForExistingImport(existing);
      if (decision) return decision(res);
      importRow = existing;
      resuming = true;
    } else {
      const insertPayload = {
        doctor_id: doctorId, ...(organizationId ? { organization_id: organizationId } : {}),
        created_by: req.user.id, nome_lista: nomeLista, filename, file_hash: fileHash,
        status: 'processando', total: result.total,
        ...(algumaAutorizada ? {
          authorization_declared_by: req.user.id,
          authorization_declared_at: new Date().toISOString(),
          authorization_declaration_version: 'v1',
        } : {}),
      };
      const { data: created, error: insertErr } = await supabase.from('lead_imports').insert(insertPayload).select().single();
      if (insertErr) {
        // Achado #5 da auditoria: corrida de duas requisições idênticas —
        // nunca deixa a perdedora estourar um 500 genérico. Ela busca o lote
        // que a vencedora acabou de criar e responde com base no status real.
        if (insertErr.code === '23505') {
          const { data: raced, error: racedErr } = await supabase.from('lead_imports').select('*')
            .eq('doctor_id', doctorId).eq('file_hash', fileHash).maybeSingle();
          if (racedErr) throw racedErr;
          if (!raced) throw insertErr;
          const decision = decideForExistingImport(raced);
          if (decision) return decision(res);
          importRow = raced;
          resuming = true;
        } else {
          throw insertErr;
        }
      } else {
        importRow = created;
      }
    }

    if (resuming) {
      const patch = { status: 'processando' };
      if (algumaAutorizada && !importRow.authorization_declared_at) {
        Object.assign(patch, {
          authorization_declared_by: req.user.id,
          authorization_declared_at: new Date().toISOString(),
          authorization_declaration_version: 'v1',
        });
      }
      const { data: updated, error: resumeErr } = await supabase.from('lead_imports')
        .update(patch).eq('id', importRow.id).select().single();
      if (resumeErr) throw resumeErr;
      importRow = updated;
    }

    // Retomada segura: pula qualquer linha já finalizada numa tentativa
    // anterior (idempotente por import_id+row_number) — só processa o que
    // ainda falta. Como o file_hash é o mesmo, `result.linhas` é
    // determinístico entre tentativas (mesmo arquivo -> mesmo row_number).
    const { data: existingRows, error: existingRowsErr } = await supabase.from('lead_import_rows')
      .select('row_number').eq('import_id', importRow.id);
    if (existingRowsErr) throw existingRowsErr;
    const jaProcessadas = new Set((existingRows || []).map((r) => r.row_number));

    try {
      for (const row of result.linhas) {
        if (jaProcessadas.has(row.row_number)) continue;
        const phoneHash = row.telefone_normalizado ? sha256Hex(row.telefone_normalizado) : null;
        if (row.status === 'invalido' || row.status === 'duplicado_arquivo') {
          const { error } = await supabase.from('lead_import_rows').insert({
            import_id: importRow.id, row_number: row.row_number,
            status: row.status,
            error_code: row.motivo, phone_hash: phoneHash,
          });
          if (error) throw error;
          continue;
        }
        let leadId;
        if (row.status === 'valido') {
          const { data: lead, error } = await supabase.from('leads').insert({
            doctor_id: doctorId, ...(organizationId ? { organization_id: organizationId } : {}),
            nome: row.nome, telefone: row.telefone_original, telefone_normalizado: row.telefone_normalizado,
            origem_lead: row.origem || null, indicado_por: row.indicado_por || null,
            status_atual: 'lead', journey_type: 'low_ticket',
            whatsapp_authorization_status: row.autorizacao_alvo,
            ...(row.autorizacao_alvo === 'autorizado' ? {
              whatsapp_authorization_at: row.data_autorizacao_iso, whatsapp_authorization_source: 'csv_import',
            } : {}),
          }).select().single();
          if (error) throw error;
          leadId = lead.id;
        } else {
          const { data: existingLead, error: loadError } = await supabase.from('leads').select('*').eq('id', row.existing_lead_id).single();
          if (loadError) throw loadError;
          leadId = existingLead.id;
          const patch = {};
          if (row.origem) patch.origem_lead = row.origem;
          if (row.indicado_por) patch.indicado_por = row.indicado_por;
          if (!existingLead.telefone_normalizado) patch.telefone_normalizado = row.telefone_normalizado;
          if ((existingLead.whatsapp_authorization_status || 'pendente') === 'pendente' && row.autorizacao_alvo === 'autorizado') {
            Object.assign(patch, { whatsapp_authorization_status: 'autorizado', whatsapp_authorization_at: row.data_autorizacao_iso, whatsapp_authorization_source: 'csv_import' });
          }
          if (Object.keys(patch).length) {
            const { error } = await supabase.from('leads').update(patch).eq('id', leadId);
            if (error) throw error;
          }
        }
        const { error: rowError } = await supabase.from('lead_import_rows').insert({
          import_id: importRow.id, row_number: row.row_number, lead_id: leadId,
          status: row.status === 'valido' ? 'criado' : 'atualizado', phone_hash: phoneHash,
        });
        if (rowError) throw rowError;
      }
    } catch (err) {
      // Achado #4 da auditoria: nunca fica preso em 'processando'. Preserva
      // as lead_import_rows já gravadas (nada é desfeito) — uma retomada
      // futura pula exatamente essas.
      await supabase.from('lead_imports').update({ status: 'falhou' }).eq('id', importRow.id).then(() => {}, () => {});
      throw err;
    }

    // Recontagem a partir de TODAS as lead_import_rows persistidas (não só as
    // processadas nesta passada) — continua correta após uma retomada parcial.
    const { data: allRows, error: allRowsErr } = await supabase.from('lead_import_rows')
      .select('status').eq('import_id', importRow.id);
    if (allRowsErr) throw allRowsErr;
    const criados = allRows.filter((r) => r.status === 'criado').length;
    const atualizados = allRows.filter((r) => r.status === 'atualizado').length;
    const duplicados = allRows.filter((r) => r.status === 'duplicado_arquivo').length;
    const invalidos = allRows.filter((r) => r.status === 'invalido').length;

    const finalPatch = { status: 'concluido', criados, atualizados, duplicados, invalidos, concluido_em: new Date().toISOString() };
    const { data: finalImport, error: finalError } = await supabase.from('lead_imports').update(finalPatch)
      .eq('id', importRow.id).select().single();
    if (finalError) throw finalError;
    res.json({ ...result, ...finalImport, import_id: importRow.id, ja_processado: false });
  } catch (err) { next(err); }
});

router.get('/imports', async (req, res, next) => {
  try {
    if (!['admin', 'doctor'].includes(req.user?.role)) {
      return res.status(403).json({ error: 'import_not_allowed_for_role' });
    }
    const doctorId = typeof req.query.doctor_id === 'string' ? req.query.doctor_id : '';
    if (!doctorId) return res.status(400).json({ error: 'doctor_id_obrigatorio' });
    if (!(await tenantAllowsDoctor(req, doctorId, getScopedDoctorIds))) return res.status(403).json({ error: 'doctor_out_of_scope' });
    const { data, error } = await supabase.from('lead_imports')
      .select('id, nome_lista, filename, total, criados, atualizados, duplicados, invalidos, status, criado_em')
      .eq('doctor_id', doctorId).order('criado_em', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { next(err); }
});

// FASE 3.3A — feedback humano da Auditoria de IA.
// Enum estrito: só os dois valores que a tela grava (a aba "reuniao" é
// derivada de status_atual, não é um feedback). `null` limpa a avaliação.
const aiFeedbackSchema = z
  .object({ feedback: z.enum(['bom', 'ruim']).nullable() })
  .strict();

// Avaliar a IA é ação EXCLUSIVA DE GESTÃO. Posse/atribuição do lead nunca
// concede acesso a este endpoint.
//   tenant ON  -> platform_admin (escopado pelo tenantContext) OU membership
//                 role em {organization_owner, organization_admin, manager}.
//   tenant OFF -> users.role em {admin, doctor}.
// Bloqueados em TODOS os modos: closer (mesmo dono/responsável), receptionist,
// professional, financial, viewer, sem membership, membership suspensa, e
// qualquer papel desconhecido.
const AI_FEEDBACK_TENANT_ROLES = new Set(['organization_owner', 'organization_admin', 'manager']);
const AI_FEEDBACK_LEGACY_ROLES = new Set(['admin', 'doctor']);

function podeAvaliarFeedbackIa(req) {
  if (req.tenant?.enabled) {
    return req.tenant.isPlatformAdmin === true || AI_FEEDBACK_TENANT_ROLES.has(req.tenant.role);
  }
  return AI_FEEDBACK_LEGACY_ROLES.has(req.user?.role);
}

// PATCH /leads/:id/ai-feedback  { feedback: 'bom' | 'ruim' | null }
// Persiste a avaliação humana de uma conversa entregue pela IA. Autor e
// timestamp vêm SEMPRE do servidor (JWT + now()), nunca do body. Responde só
// com o estado persistido do feedback — nunca a linha inteira do lead.
router.patch('/:id/ai-feedback', async (req, res, next) => {
  try {
    // (1) AUTORIZAÇÃO DE PAPEL — gestão apenas. Independente de posse do lead.
    if (!podeAvaliarFeedbackIa(req)) return res.status(403).json({ error: 'forbidden' });

    // (2) RESOLUÇÃO E ESCOPO DO RECURSO — o lead precisa existir e cair no
    // escopo de tenant/doctor do request. SEM `requireOwnerForCloser`: aquela
    // regra concede acesso ao closer por posse, o que este endpoint proíbe.
    const auth = await authorizeResource({ req, table: 'leads', id: req.params.id });
    if (!auth.ok) return res.status(auth.reason === 'not_found' ? 404 : 403).json({ error: auth.reason });

    // (3) CORPO ESTRITO
    const parsed = aiFeedbackSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

    const { feedback } = parsed.data;

    // Idempotência natural: reavaliar com o mesmo valor não reescreve nem
    // move o timestamp — devolve o estado já persistido.
    if ((auth.row.feedback_ia ?? null) === feedback) {
      return res.json({
        id: auth.row.id,
        feedback_ia: auth.row.feedback_ia ?? null,
        feedback_ia_at: auth.row.feedback_ia_at ?? null,
        feedback_ia_by: auth.row.feedback_ia_by ?? null,
      });
    }

    const patch = feedback === null
      ? { feedback_ia: null, feedback_ia_at: null, feedback_ia_by: null }
      : { feedback_ia: feedback, feedback_ia_at: new Date().toISOString(), feedback_ia_by: req.user.id };

    const { data, error } = await supabase
      .from('leads')
      .update(patch)
      .eq('id', req.params.id)
      .select('id, feedback_ia, feedback_ia_at, feedback_ia_by')
      .single();
    if (error) throw error;

    // Log estruturado sem conteúdo clínico (só id do lead + o valor do enum).
    req.log?.info({ leadId: req.params.id, feedback }, 'AI conversation feedback set');

    // Resposta mínima e explícita — nunca a linha inteira do lead, mesmo que o
    // driver não respeite a projeção do .select().
    res.json({
      id: data.id,
      feedback_ia: data.feedback_ia ?? null,
      feedback_ia_at: data.feedback_ia_at ?? null,
      feedback_ia_by: data.feedback_ia_by ?? null,
    });
  } catch (e) {
    next(e);
  }
});

// PATCH /leads/:id — atualizar status manualmente, ou reatribuir o closer responsável
router.patch('/:id', async (req, res, next) => {
  try {
    // Resolve o lead no servidor e confirma o acesso do usuário — nunca confia no :id sozinho.
    const auth = await authorizeResource({
      req,
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
      !(await assertUserAccess({ req, userId: parsed.data.sdr_responsavel_id, doctorId: auth.row.doctor_id }))
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
