import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';
import { sendWhatsAppMessage } from '../lib/whatsapp.js';
import { attachTenantContext, tenantAllowsDoctor } from '../lib/tenantContext.js';
import { CredentialVault } from '../lib/credentialVault.js';
import { env } from '../config/env.js';
import { jobQueue } from '../lib/jobQueue.js';

const router = Router();
router.use(requireAuth);
router.use(attachTenantContext);

async function checarAcesso(req, doctorId) {
  return tenantAllowsDoctor(req, doctorId, getScopedDoctorIds);
}

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
  res.json(data);
});

// POST /campanhas  { doctor_id, nome, mensagem, filtro_status }
// Cria como rascunho — o disparo de verdade acontece em /campanhas/:id/enviar,
// separado, pra dar chance de revisar antes de sair mandando mensagem.
router.post('/', async (req, res) => {
  const { doctor_id, nome, mensagem, filtro_status } = req.body;
  if (!doctor_id || !nome?.trim() || !mensagem?.trim()) {
    return res.status(400).json({ error: 'doctor_id, nome e mensagem são obrigatórios' });
  }
  if (!(await checarAcesso(req, doctor_id))) return res.status(403).json({ error: 'Sem acesso a este médico' });

  let leadsQuery = supabase.from('leads').select('id', { count: 'exact' }).eq('doctor_id', doctor_id);
  if (filtro_status) leadsQuery = leadsQuery.eq('status_atual', filtro_status);
  const { count } = await leadsQuery;

  const { data, error } = await supabase
    .from('campanhas')
    .insert({
      doctor_id,
      nome: nome.trim(),
      mensagem: mensagem.trim(),
      filtro_status: filtro_status || null,
      total_leads: count || 0,
      ...(req.tenant?.enabled && req.tenant.organizationId ? { organization_id: req.tenant.organizationId } : {}),
    })
    .select()
    .single();

  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  res.json(data);
});

// Processa o envio da campanha. Roda DESTACADO da requisição HTTP (a rota
// responde 202 na hora) — assim uma campanha grande não estoura o timeout de
// request nem segura um worker. É seguro reprocessar: o ledger `campanha_envios`
// (unique campanha+lead) garante que ninguém recebe a mesma mensagem duas vezes.
async function processarEnvioCampanha(campanha, integration, accessToken, log) {
  try {
    let leadsQuery = supabase.from('leads').select('id, nome, telefone').eq('doctor_id', campanha.doctor_id);
    if (campanha.filtro_status) leadsQuery = leadsQuery.eq('status_atual', campanha.filtro_status);
    const { data: leads, error: leadsError } = await leadsQuery;
    if (leadsError) throw leadsError;

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

      const { data: ultimaRecebida } = await supabase
        .from('conversations')
        .select('timestamp_msg')
        .eq('lead_id', lead.id)
        .eq('direcao', 'recebida')
        .order('timestamp_msg', { ascending: false })
        .limit(1)
        .maybeSingle();

      const dentroDaJanela =
        ultimaRecebida && Date.now() - new Date(ultimaRecebida.timestamp_msg).getTime() < 24 * 60 * 60 * 1000;

      if (!dentroDaJanela) {
        pendentesTemplate++;
        await supabase
          .from('campanha_envios')
          .update({ status: 'pendente_template' })
          .eq('campanha_id', campanha.id)
          .eq('lead_id', lead.id);
        continue;
      }

      try {
        await sendWhatsAppMessage(integration.external_id, accessToken, lead.telefone, campanha.mensagem);
        await supabase.from('conversations').insert({
          lead_id: lead.id,
          canal: 'whatsapp',
          direcao: 'enviada',
          conteudo: campanha.mensagem,
          origem: 'manual',
          timestamp_msg: new Date().toISOString(),
        });
        await supabase
          .from('campanha_envios')
          .update({ status: 'enviado', enviado_em: new Date().toISOString() })
          .eq('campanha_id', campanha.id)
          .eq('lead_id', lead.id);
        enviados++;
      } catch (err) {
        log?.error({ err, leadId: lead.id }, 'Campaign send to lead failed');
        await supabase
          .from('campanha_envios')
          .update({ status: 'falhou' })
          .eq('campanha_id', campanha.id)
          .eq('lead_id', lead.id);
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

  const queueMode = env.CAMPAIGN_JOB_QUEUE_ENABLED === 'true';

  // BLOQUEADOR 3: fila ligada exige organização — sem fallback pro legado.
  if (queueMode && !campanhaBase.organization_id) {
    req.log?.warn({ campanhaId: campanhaBase.id, code: 'tenant_backfill_required' }, 'Campaign send blocked: no organization');
    return res.status(409).json({ error: 'tenant_backfill_required' });
  }

  let integration;
  try {
    integration = await CredentialVault.readIntegrationCredentials({ doctorId: campanhaBase.doctor_id, gateway: 'whatsapp' });
  } catch (err) {
    req.log?.error({ err }, 'WhatsApp integration credential unreadable');
    return res.status(400).json({ error: 'WhatsApp não configurado para este médico' });
  }

  const accessToken = integration?.access_token || process.env.META_SYSTEM_USER_TOKEN;
  if (!integration?.external_id || !accessToken) {
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
  processarEnvioCampanha(campanha, integration, accessToken, req.log);
});

export default router;
