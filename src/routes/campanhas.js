import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';
import { sendWhatsAppMessage, sendWhatsAppTemplate } from '../lib/whatsapp.js';
import { attachTenantContext, tenantAllowsDoctor } from '../lib/tenantContext.js';
import { CredentialVault } from '../lib/credentialVault.js';
import { env } from '../config/env.js';
import { jobQueue } from '../lib/jobQueue.js';
import { usageQuota } from '../lib/usageQuota.js';
import { resolveCanonicalSendPhone, isPhoneIdentityReviewRequired } from '../lib/phoneNormalization.js';
import { isWithinFreeTextWindow } from '../lib/whatsappMessageWindow.js';
import {
  isTemplateReadyToSend, validateTemplateVariableMap, buildTemplateSnapshot,
  renderTemplateBodyParameters, sanitizeMetaErrorCode,
} from '../lib/whatsappTemplates.js';
import { waitForSendSlot } from '../lib/whatsappPacing.js';
import { countCampaignSendableRecipients } from '../lib/campaignRecipients.js';

const router = Router();
router.use(requireAuth);
router.use(attachTenantContext);

async function checarAcesso(req, doctorId) {
  return tenantAllowsDoctor(req, doctorId, getScopedDoctorIds);
}

async function importLeadIds(importId, client = supabase) {
  if (!importId) return null;
  const { data, error } = await client.from('lead_import_rows').select('lead_id')
    .eq('import_id', importId).in('status', ['criado', 'atualizado']);
  if (error) throw error;
  return [...new Set((data || []).map((row) => row.lead_id).filter(Boolean))];
}

async function campaignCounts(campaign) {
  const ids = await importLeadIds(campaign.import_id);
  if (ids && !ids.length) return { elegiveis: 0, bloqueados: 0 };
  let query = supabase.from('leads').select('id, telefone, telefone_normalizado, whatsapp_authorization_status')
    .eq('doctor_id', campaign.doctor_id);
  if (campaign.filtro_status) query = query.eq('status_atual', campaign.filtro_status);
  if (ids) query = query.in('id', ids);
  const { data, error } = await query;
  if (error) throw error;
  const all = data || [];
  const elegiveis = all.filter((lead) => lead.whatsapp_authorization_status === 'autorizado'
    && resolveCanonicalSendPhone(lead).ok).length;
  return { elegiveis, bloqueados: all.length - elegiveis };
}

const enrichCampaign = async (campaign) => ({ ...campaign, ...(await campaignCounts(campaign)) });

// `Number(x) || default` trataria '0' (configuração legítima — pacing
// desligado) como "ausente" e cairia no default, já que 0 é falsy em JS.
// Number.isFinite evita esse bug: só usa o default quando o valor realmente
// não é um número (nunca quando é 0 de propósito).
const MAX_RECIPIENTS = () => {
  const n = Number(env.WHATSAPP_CAMPAIGN_MAX_RECIPIENTS);
  return Number.isFinite(n) && n > 0 ? n : 100;
};
const SEND_INTERVAL_MS = () => {
  const n = Number(env.WHATSAPP_SEND_INTERVAL_MS);
  return Number.isFinite(n) ? n : 1000;
};

// GET /campanhas?doctor_id=
router.get('/', async (req, res) => {
  const { doctor_id } = req.query;
  if (!doctor_id) return res.status(400).json({ error: 'doctor_id necessário' });
  if (!(await checarAcesso(req, doctor_id))) return res.status(403).json({ error: 'Sem acesso a este médico' });

  const { data, error } = await supabase
    .from('campanhas')
    .select('*')
    .eq('doctor_id', doctor_id)
    .order('criado_em', { ascending: false });

  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  res.json(await Promise.all((data || []).map(enrichCampaign)));
});

router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('campanhas').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: 'internal_error', requestId: req.id });
  if (!data) return res.status(404).json({ error: 'campanha_not_found' });
  if (!(await checarAcesso(req, data.doctor_id))) return res.status(403).json({ error: 'forbidden' });
  res.json(await enrichCampaign(data));
});

// POST /campanhas  { doctor_id, nome, mensagem?, filtro_status?, import_id?,
//                     modo_envio?, whatsapp_template_id?, template_variable_map? }
//
// FASE 2 — duas formas de envio, nunca misturadas dentro da mesma campanha:
//   - modo_envio='texto_livre' (default, preserva o comportamento anterior):
//     exige `mensagem`, respeita a janela de 24h no disparo.
//   - modo_envio='template': exige um template do MESMO médico que esteja
//     aprovado, ativo, suportado e com sync recente; a quantidade/posição de
//     `template_variable_map` tem que bater exatamente com o BODY do
//     template. `template_snapshot` congela os dados no momento da criação
//     (só auditoria — o envio sempre revalida contra o cache atual).
// Cria como rascunho — o disparo de verdade acontece em /campanhas/:id/enviar.
router.post('/', async (req, res) => {
  const { doctor_id, nome, mensagem, filtro_status, import_id, whatsapp_template_id, template_variable_map } = req.body;
  const modo_envio = req.body.modo_envio === 'template' ? 'template' : 'texto_livre';

  if (!doctor_id || !nome?.trim()) {
    return res.status(400).json({ error: 'doctor_id e nome são obrigatórios' });
  }
  if (!(await checarAcesso(req, doctor_id))) return res.status(403).json({ error: 'Sem acesso a este médico' });

  if (import_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(import_id)) {
    return res.status(400).json({ error: 'import_id_invalido' });
  }
  // Lista importada (CSV com consentimento declarado) SÓ pode ser usada com
  // template aprovado — nunca texto livre, que dependeria de uma janela de
  // 24h que uma lista importada nunca tem (o lead nunca respondeu ainda).
  if (import_id && modo_envio !== 'template') {
    return res.status(400).json({ error: 'import_requires_template_mode' });
  }
  if (import_id) {
    const { data: imported } = await supabase.from('lead_imports').select('id, doctor_id').eq('id', import_id).maybeSingle();
    if (!imported) return res.status(404).json({ error: 'import_not_found' });
    if (imported.doctor_id !== doctor_id) return res.status(403).json({ error: 'import_doctor_mismatch' });
  }

  let templateSnapshot = null;
  let mensagemFinal = null;

  if (modo_envio === 'template') {
    if (!whatsapp_template_id) return res.status(400).json({ error: 'whatsapp_template_id_required' });
    const { data: tmpl, error: tmplErr } = await supabase.from('whatsapp_templates').select('*').eq('id', whatsapp_template_id).maybeSingle();
    if (tmplErr) { req.log?.error({ err: tmplErr }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
    // Template de outro médico: nunca revelado, sempre 403 (evita enumeração).
    if (!tmpl || tmpl.doctor_id !== doctor_id) return res.status(403).json({ error: 'template_forbidden' });
    if (!isTemplateReadyToSend(tmpl)) return res.status(409).json({ error: 'template_not_ready' });
    const validation = validateTemplateVariableMap(tmpl.body_variable_count, template_variable_map);
    if (!validation.ok) return res.status(400).json({ error: validation.reason });
    templateSnapshot = buildTemplateSnapshot(tmpl, template_variable_map);
    // `campanhas.mensagem` é NOT NULL no banco mesmo para campanhas de
    // template — que nunca usam este campo pra enviar de verdade (o envio de
    // template sempre lê `template_snapshot`/`whatsapp_template_id`, nunca
    // `mensagem`; ver processarEnvioCampanha/handleCampaignSendJob). Grava
    // aqui só um SNAPSHOT do corpo do template já validado no banco
    // (`tmpl.body_text`) — nunca um texto vindo do cliente, que poderia
    // divergir do que o template realmente envia.
    mensagemFinal = tmpl.body_text;
  } else if (!mensagem?.trim()) {
    return res.status(400).json({ error: 'mensagem_obrigatoria_texto_livre' });
  } else {
    mensagemFinal = mensagem.trim();
  }

  const ids = await importLeadIds(import_id);
  let leadsQuery = supabase.from('leads').select('id').eq('doctor_id', doctor_id);
  if (filtro_status) leadsQuery = leadsQuery.eq('status_atual', filtro_status);
  if (ids) leadsQuery = leadsQuery.in('id', ids);
  const { data: baseLeads } = await leadsQuery;

  const { data, error } = await supabase
    .from('campanhas')
    .insert({
      doctor_id,
      nome: nome.trim(),
      mensagem: mensagemFinal,
      filtro_status: filtro_status || null,
      total_leads: baseLeads?.length || 0,
      import_id: import_id || null,
      modo_envio,
      whatsapp_template_id: modo_envio === 'template' ? whatsapp_template_id : null,
      template_variable_map: modo_envio === 'template' ? template_variable_map : null,
      template_snapshot: templateSnapshot,
      ...(req.tenant?.enabled && req.tenant.organizationId ? { organization_id: req.tenant.organizationId } : {}),
    })
    .select()
    .single();

  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  res.json(await enrichCampaign(data));
});

// Resolve, para UM destinatário, o resultado do gate de envio comum aos dois
// modos: consentimento, quarentena e telefone canônico. Nunca decide sobre
// janela de 24h nem template — isso é responsabilidade de quem chama.
function evaluateRecipientGate(freshLead, campanha) {
  if (!freshLead || freshLead.doctor_id !== campanha.doctor_id) return 'sem_autorizacao';
  if (isPhoneIdentityReviewRequired(freshLead)) return 'phone_identity_review_required';
  if (freshLead.whatsapp_authorization_status === 'opt_out') return 'opt_out';
  if (freshLead.whatsapp_authorization_status !== 'autorizado') return 'sem_autorizacao';
  if (!resolveCanonicalSendPhone(freshLead).ok) return 'invalid_recipient_phone';
  return null;
}

// Processa o envio da campanha. Roda DESTACADO da requisição HTTP (a rota
// responde 202 na hora) — assim uma campanha grande não estoura o timeout de
// request nem segura um worker. É seguro reprocessar: o ledger `campanha_envios`
// (unique campanha+lead) garante que ninguém recebe a mesma mensagem duas vezes.
//
// FASE 2 — limite de destinatários por disparo (WHATSAPP_CAMPAIGN_MAX_RECIPIENTS)
// e pacing serial por médico (WHATSAPP_SEND_INTERVAL_MS, ver whatsappPacing.js)
// valem para os dois modos de envio.
export async function processarEnvioCampanha(campanha, externalId, accessToken, log) {
  try {
    // Defesa redundante contra corrida: a rota /enviar já rejeita com 422
    // ANTES de chegar aqui se o total de elegíveis passar do teto. Se, ainda
    // assim, mais leads viraram elegíveis entre aquele gate e esta execução
    // destacada, a operação inteira aborta — nunca envia um subconjunto
    // parcial silenciosamente.
    const maxRecipients = MAX_RECIPIENTS();
    const eligibleCount = await countCampaignSendableRecipients(supabase, campanha);
    if (eligibleCount > maxRecipients) {
      log?.error({ campanhaId: campanha.id, code: 'campaign_recipient_limit_exceeded', eligibleCount, maxRecipients }, 'Campaign send aborted: recipient count exceeds configured limit');
      await supabase.from('campanhas').update({ status: 'erro', processando_desde: null }).eq('id', campanha.id);
      return;
    }

    const ids = await importLeadIds(campanha.import_id);
    let leadsQuery = supabase.from('leads').select('id, nome, telefone_normalizado')
      .eq('doctor_id', campanha.doctor_id).eq('whatsapp_authorization_status', 'autorizado');
    if (campanha.filtro_status) leadsQuery = leadsQuery.eq('status_atual', campanha.filtro_status);
    if (ids) leadsQuery = leadsQuery.in('id', ids);
    const { data: leads, error: leadsError } = await leadsQuery;
    if (leadsError) throw leadsError;

    // Template: revalida (não confia no snapshot) e carrega o nome do médico
    // uma única vez — usado se `doctor_nome` estiver mapeado em alguma variável.
    let templateAtual = null;
    let doctorNome = null;
    if (campanha.modo_envio === 'template') {
      const { data: tmpl } = await supabase.from('whatsapp_templates').select('*').eq('id', campanha.whatsapp_template_id).maybeSingle();
      templateAtual = tmpl || null;
      const { data: doc } = await supabase.from('doctors').select('nome').eq('id', campanha.doctor_id).maybeSingle();
      doctorNome = doc?.nome || null;
    }

    let enviados = 0;
    let pendentesTemplate = 0;

    for (const lead of leads || []) {
      // Idempotência por destinatário: reserva a linha antes de enviar.
      const { data: reserva, error: reservaError } = await supabase
        .from('campanha_envios')
        .upsert(
          { campanha_id: campanha.id, lead_id: lead.id, status: 'enviando' },
          { onConflict: 'campanha_id,lead_id', ignoreDuplicates: true }
        )
        .select('id')
        .maybeSingle();
      if (reservaError) throw reservaError;
      if (!reserva) continue; // já processado num envio anterior

      if (campanha.modo_envio === 'texto_livre') {
        const { data: ultimaRecebida } = await supabase
          .from('conversations')
          .select('timestamp_msg')
          .eq('lead_id', lead.id)
          .eq('direcao', 'recebida')
          .order('timestamp_msg', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!isWithinFreeTextWindow(ultimaRecebida?.timestamp_msg)) {
          pendentesTemplate++;
          await supabase.from('campanha_envios').update({ status: 'pendente_template' })
            .eq('campanha_id', campanha.id).eq('lead_id', lead.id);
          continue;
        }
      }
      // modo_envio='template' NUNCA depende da janela de 24h.

      const { data: freshLead } = await supabase.from('leads')
        .select('id, doctor_id, telefone, telefone_normalizado, whatsapp_authorization_status, dados_extraidos')
        .eq('id', lead.id).maybeSingle();
      const blockedStatus = evaluateRecipientGate(freshLead, campanha);
      if (blockedStatus) {
        await supabase.from('campanha_envios').update({ status: blockedStatus })
          .eq('campanha_id', campanha.id).eq('lead_id', lead.id);
        continue;
      }
      const destino = resolveCanonicalSendPhone(freshLead);

      // Template ainda válido IMEDIATAMENTE antes do envio — refaz a LEITURA
      // no banco por destinatário (nunca reusa o `templateAtual` capturado
      // uma única vez antes do loop inteiro: numa campanha longa, com pacing
      // real entre cada lead, um sync concorrente pode ter mudado o template
      // muito depois dessa primeira leitura).
      let templateParaEnvio = templateAtual;
      if (campanha.modo_envio === 'template') {
        const { data: tmplNow } = await supabase.from('whatsapp_templates').select('*').eq('id', campanha.whatsapp_template_id).maybeSingle();
        if (!tmplNow || tmplNow.doctor_id !== campanha.doctor_id || !isTemplateReadyToSend(tmplNow)) {
          await supabase.from('campanha_envios').update({ status: 'template_indisponivel' })
            .eq('campanha_id', campanha.id).eq('lead_id', lead.id);
          continue;
        }
        templateParaEnvio = tmplNow;
      }

      await waitForSendSlot(campanha.doctor_id, SEND_INTERVAL_MS());

      try {
        if (campanha.modo_envio === 'template') {
          const parametros = renderTemplateBodyParameters(templateParaEnvio.body_variable_count, campanha.template_variable_map, {
            leadNome: lead.nome, doctorNome,
          });
          const { messageId } = await sendWhatsAppTemplate(externalId, accessToken, destino.phone, {
            name: templateParaEnvio.nome, languageCode: templateParaEnvio.idioma, bodyParameters: parametros,
          });
          await supabase.from('conversations').insert({
            lead_id: lead.id, canal: 'whatsapp', direcao: 'enviada',
            conteudo: templateParaEnvio.body_text, origem: 'manual', timestamp_msg: new Date().toISOString(),
          });
          await supabase.from('campanha_envios').update({
            status: 'enviado', enviado_em: new Date().toISOString(),
            message_id: messageId, meta_status: 'accepted',
          }).eq('campanha_id', campanha.id).eq('lead_id', lead.id);
        } else {
          await sendWhatsAppMessage(externalId, accessToken, destino.phone, campanha.mensagem);
          await supabase.from('conversations').insert({
            lead_id: lead.id, canal: 'whatsapp', direcao: 'enviada',
            conteudo: campanha.mensagem, origem: 'manual', timestamp_msg: new Date().toISOString(),
          });
          await supabase.from('campanha_envios').update({ status: 'enviado', enviado_em: new Date().toISOString() })
            .eq('campanha_id', campanha.id).eq('lead_id', lead.id);
        }
        enviados++;
      } catch (err) {
        log?.error({ err: { code: err?.networkError ? 'network_error' : (err?.metaError?.code ?? 'send_failed') }, leadId: lead.id }, 'Campaign send to lead failed');
        // Sem conexão/timeout: nunca sabemos se a Meta recebeu — nunca reenviar
        // silenciosamente, fica para revisão manual.
        const status = err?.networkError ? 'resultado_desconhecido' : 'falhou';
        await supabase.from('campanha_envios').update({
          status, meta_error_code: err?.metaError ? sanitizeMetaErrorCode(err.metaError) : null,
        }).eq('campanha_id', campanha.id).eq('lead_id', lead.id);
      }
    }

    await supabase
      .from('campanhas')
      .update({
        status: 'concluida',
        enviados,
        pendentes_template: pendentesTemplate,
        enviado_em: new Date().toISOString(),
        processando_desde: null,
      })
      .eq('id', campanha.id);
  } catch (err) {
    log?.error({ err, campanhaId: campanha.id }, 'Campaign run failed');
    // Estado seguro e RE-CLAIMÁVEL — nunca fica preso em 'processando'.
    await supabase.from('campanhas').update({ status: 'erro', processando_desde: null }).eq('id', campanha.id);
  }
}

// POST /campanhas/:id/enviar
//
// Anti-duplicação (RACE01):
//  - Aquisição ATÔMICA: só UMA requisição muda 'rascunho'|'erro' -> 'processando'.
//    Uma segunda requisição simultânea recebe 409 e não envia nada.
//
// FASE 2.8 (CAMPAIGN_JOB_QUEUE_ENABLED=true):
//  - BLOQUEADOR 1 — o 202 SÓ sai depois de UM job `campaign.dispatch`
//    persistido de forma durável e idempotente (não há janela entre o 202 e
//    a primeira persistência). O handler `campaign.dispatch` pagina os leads
//    e enfileira os `campaign.send_message` (retomável após reinício: as
//    operações são idempotentes — `campanha_envios` unique + idempotency_key
//    do job). Nenhum job de destinatário é criado dentro da request.
//  - BLOQUEADOR 3 — com a flag ligada, campanha SEM organization_id falha
//    fechada (409 tenant_backfill_required) ANTES de qualquer WhatsApp;
//    NUNCA cai no fluxo legado (que não passa por fila nem quota).
//  - flag OFF: fluxo legado 100% preservado (loop destacado, 202 imediato).
router.post('/:id/enviar', async (req, res) => {
  const { data: campanhaBase } = await supabase.from('campanhas').select('*').eq('id', req.params.id).single();
  if (!campanhaBase) return res.status(404).json({ error: 'Campanha não encontrada' });
  if (!(await checarAcesso(req, campanhaBase.doctor_id))) return res.status(403).json({ error: 'Sem acesso' });

  // FASE 2 (auditoria) — limite de destinatários é tudo-ou-nada: conta ANTES
  // de criar qualquer ledger/job, e se passar do teto, rejeita a operação
  // INTEIRA. Nunca envia um subconjunto truncado silenciosamente.
  const maxRecipients = MAX_RECIPIENTS();
  const eligibleCount = await countCampaignSendableRecipients(supabase, campanhaBase);
  if (eligibleCount > maxRecipients) {
    return res.status(422).json({
      error: 'campaign_recipient_limit_exceeded',
      eligible_count: eligibleCount,
      max_recipients: maxRecipients,
    });
  }

  const queueMode = env.CAMPAIGN_JOB_QUEUE_ENABLED === 'true';

  // BLOQUEADOR 3: fila ligada exige organização — sem fallback pro legado.
  if (queueMode && !campanhaBase.organization_id) {
    req.log?.warn({ campanhaId: campanhaBase.id, code: 'tenant_backfill_required' }, 'Campaign send blocked: no organization');
    return res.status(409).json({ error: 'tenant_backfill_required' });
  }

  // Revalida o template IMEDIATAMENTE antes de aceitar o disparo — mesmo já
  // validado na criação, o cache pode ter mudado desde então (sync mais
  // recente derrubou o template, ou ele deixou de estar aprovado/ativo).
  if (campanhaBase.modo_envio === 'template') {
    const { data: tmpl } = await supabase.from('whatsapp_templates').select('*').eq('id', campanhaBase.whatsapp_template_id).maybeSingle();
    if (!tmpl || tmpl.doctor_id !== campanhaBase.doctor_id || !isTemplateReadyToSend(tmpl)) {
      return res.status(409).json({ error: 'template_not_ready' });
    }
  }

  let credentials;
  try {
    credentials = await CredentialVault.resolveWhatsAppSendCredentials({ doctorId: campanhaBase.doctor_id });
  } catch (err) {
    req.log?.error({ err }, 'WhatsApp integration credential unreadable');
    return res.status(400).json({ error: 'WhatsApp não configurado para este médico' });
  }

  const { externalId, accessToken } = credentials;
  if (!externalId || !accessToken) {
    return res.status(400).json({ error: 'WhatsApp não configurado para este médico' });
  }

  // Recupera envio órfão: se um processo reiniciou no meio, a campanha fica
  // presa em 'processando'. Depois de 15 min sem concluir, marcamos como 'erro'
  // para que o disparo abaixo consiga retomá-la (o ledger torna isso seguro).
  const staleThreshold = new Date(Date.now() - 15 * 60_000).toISOString();
  await supabase
    .from('campanhas')
    .update({ status: 'erro' })
    .eq('id', req.params.id)
    .eq('status', 'processando')
    .lt('processando_desde', staleThreshold);

  // --- Aquisição atômica: (rascunho | erro) -> processando ---
  const { data: campanha, error: claimError } = await supabase
    .from('campanhas')
    .update({ status: 'processando', processando_desde: new Date().toISOString() })
    .eq('id', req.params.id)
    .in('status', ['rascunho', 'erro'])
    .select()
    .maybeSingle();

  if (claimError) {
    req.log?.error({ err: claimError }, 'Database request failed');
    return res.status(500).json({ error: 'internal_error', requestId: req.id });
  }
  if (!campanha) {
    // Outra requisição já pegou, ou a campanha já foi concluída.
    return res.status(409).json({ error: 'campanha_em_processamento_ou_ja_enviada' });
  }

  if (queueMode) {
    // BLOQUEADOR 1: o 202 só sai DEPOIS que este job existe no banco. A
    // idempotency_key inclui `processando_desde` (novo a cada disparo) — um
    // re-disparo da mesma campanha gera um dispatch NOVO, não reaproveita o
    // job já completado de um disparo anterior. Duas requisições concorrentes
    // não chegam aqui juntas (a aquisição atômica acima já deu 409 pra uma).
    try {
      const dispatch = await jobQueue.enqueue(
        'campaign.dispatch',
        { campaignId: campanha.id },
        { organizationId: campanha.organization_id, idempotencyKey: `dispatch:${campanha.id}:${campanha.processando_desde}` },
      );
      return res.status(202).json({ id: campanha.id, job_id: dispatch.id, status: 'processando' });
    } catch (err) {
      await supabase.from('campanhas').update({ status: 'erro', processando_desde: null }).eq('id', campanha.id).then(() => {}, () => {});
      req.log?.error({ err: { code: err?.code || 'dispatch_enqueue_failed' }, campanhaId: campanha.id }, 'Campaign dispatch enqueue failed');
      return res.status(500).json({ error: 'internal_error', requestId: req.id });
    }
  }

  // --- legado (flag OFF): 202 imediato + loop destacado, inalterado ---
  res.status(202).json({ id: campanha.id, status: 'processando' });
  processarEnvioCampanha(campanha, externalId, accessToken, req.log);
});

export default router;
