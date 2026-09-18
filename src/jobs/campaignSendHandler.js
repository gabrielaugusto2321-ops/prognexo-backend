import { supabase } from '../lib/supabase.js';
import { sendWhatsAppMessage, sendWhatsAppTemplate } from '../lib/whatsapp.js';
import { CredentialVault } from '../lib/credentialVault.js';
import { jobQueue } from '../lib/jobQueue.js';
import { usageQuota } from '../lib/usageQuota.js';
import { resolveCanonicalSendPhone, isPhoneIdentityReviewRequired } from '../lib/phoneNormalization.js';
import { isWithinFreeTextWindow } from '../lib/whatsappMessageWindow.js';
import { isTemplateReadyToSend, renderTemplateBodyParameters, isPermanentTemplateError, sanitizeMetaErrorCode } from '../lib/whatsappTemplates.js';
import { waitForSendSlot } from '../lib/whatsappPacing.js';
import { env } from '../config/env.js';
import { countCampaignSendableRecipients } from '../lib/campaignRecipients.js';

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
const SEND_LOCK_STALE_MS = () => {
  const n = Number(env.WHATSAPP_SEND_LOCK_STALE_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
};

const safeCode = (err) => String(err?.code || err?.message || err?.name || 'campaign_job_failed')
  .toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'campaign_job_failed';

// Backoff exponencial com jitter (teto 1h). `quota_denied` segura 1h fixa (a
// quota só libera na virada da janela). `campaign_not_drained` é o
// "poll de novo em 60s" do finalizador — não é erro de verdade.
function retryAt(attempts, code) {
  if (code === 'quota_denied') return new Date(Date.now() + 3600_000);
  if (code === 'campaign_not_drained') return new Date(Date.now() + 60_000);
  const base = Math.min(3600_000, 1000 * (2 ** Math.max(0, attempts)));
  return new Date(Date.now() + base + Math.floor(Math.random() * 1000));
}

async function markEnvio(client, campaignId, leadId, status, extra = {}) {
  await client.from('campanha_envios').update({ status, ...extra })
    .eq('campanha_id', campaignId).eq('lead_id', leadId);
}

// Transição atômica (compare-and-swap via UPDATE condicional) para o estado
// "chamando a Meta agora" — feita imediatamente antes da requisição HTTP,
// nunca antes. Só UMA execução consegue setar `envio_iniciado_em` enquanto
// ele estiver nulo E o status ainda for 'enviando'; qualquer outra (reclaim
// concorrente ou sequencial após lease expirada) recebe 0 linhas e nunca
// chega a chamar a Meta. Isso fecha a janela entre "a Meta aceitou" e "o
// banco registrou o sucesso": se o worker morre nesse meio, a PRÓXIMA
// execução encontra `envio_iniciado_em` já preenchido (a trava não foi
// liberada por ninguém) e sabe que uma tentativa anterior começou e nunca
// terminou — nunca reenvia, marca resultado_desconhecido.
async function acquireSendLock(client, campaignId, leadId) {
  const { data } = await client.from('campanha_envios')
    .update({ envio_iniciado_em: new Date().toISOString() })
    .eq('campanha_id', campaignId).eq('lead_id', leadId)
    .eq('status', 'enviando').is('envio_iniciado_em', null)
    .select('id').maybeSingle();
  return !!data;
}

// Libera a trava só quando a tentativa que a segurou vai mesmo tentar de novo
// (retry legítimo por rejeição confirmada, não é dead_letter) — nunca para um
// resultado ambíguo ou um crash puro, onde a trava PRECISA continuar presa
// pra a próxima execução detectar o "enviando" abandonado.
async function releaseSendLock(client, campaignId, leadId) {
  await client.from('campanha_envios').update({ envio_iniciado_em: null })
    .eq('campanha_id', campaignId).eq('lead_id', leadId).then(() => {}, () => {});
}

const DISPATCH_BATCH = 500;
const FINALIZE_MAX_ATTEMPTS = 200; // ~3.3h de poll a 60s antes de dead_letter

async function importedLeadIds(client, importId) {
  if (!importId) return null;
  const { data, error } = await client.from('lead_import_rows').select('lead_id')
    .eq('import_id', importId).in('status', ['criado', 'atualizado']);
  if (error) throw error;
  return [...new Set((data || []).map((row) => row.lead_id).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// campaign.dispatch — pagina os leads e enfileira 1 campaign.send_message por
// destinatário NOVO. Totalmente retomável: `campanha_envios` (unique
// campanha+lead) + a idempotency_key do job garantem que reprocessar o
// dispatch do zero não perde nem duplica ninguém. NENHUM job é criado dentro
// da request HTTP — só aqui, no worker.
// ---------------------------------------------------------------------------
export async function handleCampaignDispatchJob(job, {
  workerId, client = supabase, queue = jobQueue, log, batchSize = DISPATCH_BATCH,
} = {}) {
  let campaignId;
  try {
    ({ campaignId } = queue.decodePayload(job, { sensitive: false }));
    const { data: campaign } = await client.from('campanhas').select('*').eq('id', campaignId).single();
    if (!campaign) { await queue.complete({ jobId: job.id, workerId }); return true; }
    if (campaign.status === 'cancelada') { await queue.complete({ jobId: job.id, workerId }); return true; }

    // FASE 2 (auditoria) — limite de destinatários é tudo-ou-nada. A rota
    // /enviar já rejeita com 422 antes de sequer criar este job; esta é uma
    // segunda checagem defensiva contra corrida (leads podem ter virado
    // elegíveis entre o gate da rota e esta execução assíncrona). Se ainda
    // assim passar do teto, ABORTA POR COMPLETO — nunca enfileira um
    // subconjunto truncado silenciosamente.
    const maxRecipients = MAX_RECIPIENTS();
    const eligibleCount = await countCampaignSendableRecipients(client, campaign);
    if (eligibleCount > maxRecipients) {
      log?.error({ campaignId: campaign.id, code: 'campaign_recipient_limit_exceeded', eligibleCount, maxRecipients }, 'Campaign dispatch aborted: recipient count exceeds configured limit');
      await client.from('campanhas').update({ status: 'erro', processando_desde: null }).eq('id', campaignId).then(() => {}, () => {});
      await queue.complete({ jobId: job.id, workerId });
      return true;
    }

    const importIds = await importedLeadIds(client, campaign.import_id);
    if (importIds && importIds.length === 0) {
      await queue.enqueue('campaign.finalize', { campaignId: campaign.id, dispatchKey: job.idempotency_key },
        { organizationId: campaign.organization_id, idempotencyKey: `finalize:${job.idempotency_key}`, maxAttempts: FINALIZE_MAX_ATTEMPTS, priority: -1 });
      await queue.complete({ jobId: job.id, workerId });
      return true;
    }

    // Paginação estável por leads.id (uuid — ordem arbitrária mas
    // determinística; `id > cursor` varre tudo uma vez). Sem teto aqui: o
    // gate acima já garante que o total elegível cabe no limite configurado.
    let cursor = null;
    for (;;) {
      let q = client.from('leads').select('id').eq('doctor_id', campaign.doctor_id)
        .eq('whatsapp_authorization_status', 'autorizado').order('id', { ascending: true })
        .limit(batchSize);
      if (campaign.filtro_status) q = q.eq('status_atual', campaign.filtro_status);
      if (importIds) q = q.in('id', importIds);
      if (cursor) q = q.gt('id', cursor);
      const { data: leads, error } = await q;
      if (error) throw error;
      if (!leads || leads.length === 0) break;

      for (const lead of leads) {
        // Uma ÚNICA operação transacional cria/localiza campanha_envios E o
        // job juntos — visíveis só após o commit. Um estado terminal
        // ('enviado'/'falhou'/...) nunca é rebaixado nem gera job novo num
        // retry do mesmo dispatch (a RPC devolve `terminal:true`).
        await queue.enqueueCampaignRecipient({
          campaignId: campaign.id, leadId: lead.id,
          doctorId: campaign.doctor_id, organizationId: campaign.organization_id,
        });
      }
      cursor = leads[leads.length - 1].id;
      // dispatch de campanha grande pode passar da lease — renova.
      await queue.heartbeat({ jobId: job.id, workerId, leaseSeconds: 300 }).catch(() => {});
    }

    // Enfileira o finalizador (idempotente por disparo). Ele é quem fecha a
    // campanha — os handlers de send NÃO tocam no status da campanha, pra
    // não fechá-la enquanto o dispatch ainda pagina. `priority:-1` +30s pra
    // ser claimado DEPOIS dos sends (se rodar antes, só vê 'enviando' e
    // re-agenda — nunca conclui cedo demais).
    await queue.enqueue('campaign.finalize', { campaignId: campaign.id, dispatchKey: job.idempotency_key },
      { organizationId: campaign.organization_id, idempotencyKey: `finalize:${job.idempotency_key}`, maxAttempts: FINALIZE_MAX_ATTEMPTS, priority: -1, runAt: new Date(Date.now() + 30_000) });
    await queue.complete({ jobId: job.id, workerId });
    return true;
  } catch (err) {
    const code = safeCode(err);
    log?.error({ err: { code }, jobId: job.id }, 'Campaign dispatch failed');
    let result;
    try { result = await queue.retry({ jobId: job.id, workerId, errorCode: code, availableAt: retryAt(job.attempts, code) }); }
    catch { return false; }
    if (result?.status === 'dead_letter' && campaignId) {
      // dispatch morto -> campanha volta a 'erro' (re-disparável), nunca presa.
      await client.from('campanhas').update({ status: 'erro', processando_desde: null }).eq('id', campaignId).then(() => {}, () => {});
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// campaign.finalize — fecha a campanha quando todos os `campanha_envios`
// saíram de 'enviando'. Enquanto não, se re-agenda (retry a 60s). Se ficar
// preso além de FINALIZE_MAX_ATTEMPTS (~3.3h) vira dead_letter e a campanha
// vai pra 'erro' (recuperável). Idempotente.
// ---------------------------------------------------------------------------
export async function handleCampaignFinalizeJob(job, { workerId, client = supabase, queue = jobQueue, log } = {}) {
  let campaignId;
  try {
    ({ campaignId } = queue.decodePayload(job, { sensitive: false }));
    const { data: rows } = await client.from('campanha_envios').select('status').eq('campanha_id', campaignId);
    const list = rows || [];
    if (list.some((r) => r.status === 'enviando')) {
      // ainda tem send em voo — re-agenda. Se ESTE re-agendamento esgotou
      // FINALIZE_MAX_ATTEMPTS (campanha presa há ~3.3h), o job vira
      // dead_letter e a campanha vai pra 'erro' (recuperável), nunca fica
      // eternamente 'processando'.
      const r = await queue.retry({ jobId: job.id, workerId, errorCode: 'campaign_not_drained', availableAt: retryAt(job.attempts, 'campaign_not_drained') });
      if (r?.status === 'dead_letter') {
        await client.from('campanhas').update({ status: 'erro', processando_desde: null }).eq('id', campaignId).then(() => {}, () => {});
      }
      return false;
    }
    await client.from('campanhas').update({
      status: 'concluida',
      enviados: list.filter((r) => r.status === 'enviado').length,
      pendentes_template: list.filter((r) => r.status === 'pendente_template').length,
      enviado_em: new Date().toISOString(),
      processando_desde: null,
    }).eq('id', campaignId);
    await queue.complete({ jobId: job.id, workerId });
    return true;
  } catch (err) {
    const code = safeCode(err);
    log?.error({ err: { code }, jobId: job.id }, 'Campaign finalize failed');
    let result;
    try { result = await queue.retry({ jobId: job.id, workerId, errorCode: code, availableAt: retryAt(job.attempts, code) }); }
    catch { return false; }
    if (result?.status === 'dead_letter' && campaignId) {
      await client.from('campanhas').update({ status: 'erro', processando_desde: null }).eq('id', campaignId).then(() => {}, () => {});
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// campaign.send_message — 1 destinatário. Reserva quota ANTES da Meta,
// settle em sucesso, release só se a Meta nem foi chamada.
// ---------------------------------------------------------------------------
const LEAD_SEND_SELECT = 'id,nome,doctor_id,telefone,telefone_normalizado,whatsapp_authorization_status,dados_extraidos';

export async function handleCampaignSendJob(job, {
  workerId, client = supabase, queue = jobQueue, quota = usageQuota,
  send = sendWhatsAppMessage, sendTemplate = sendWhatsAppTemplate,
  credentialVault = CredentialVault, log,
} = {}) {
  let reservationId;
  let lockAcquired = false;
  let campaignId;
  let leadId;
  try {
    let doctorId;
    ({ campaignId, leadId, doctorId } = queue.decodePayload(job, { sensitive: true }));

    // Idempotência contra reprocessamento do MESMO job: se o worker morreu
    // depois da Meta aceitar (ou depois de qualquer outro desfecho terminal)
    // mas antes de completar o job, o lease expira e outro claim roda este
    // handler de novo do zero. `campanha_envios.status` só fica 'enviando'
    // enquanto o envio está em aberto — qualquer outro valor já é terminal
    // (setado por este mesmo handler) e nunca deve disparar a Meta de novo.
    const { data: envioAtual } = await client.from('campanha_envios').select('status')
      .eq('campanha_id', campaignId).eq('lead_id', leadId).maybeSingle();
    if (envioAtual && envioAtual.status !== 'enviando') {
      await queue.complete({ jobId: job.id, workerId });
      return true;
    }

    const [{ data: campaign }, { data: lead }, credentials] = await Promise.all([
      client.from('campanhas').select('*').eq('id', campaignId).single(),
      client.from('leads').select(LEAD_SEND_SELECT).eq('id', leadId).maybeSingle(),
      credentialVault.resolveWhatsAppSendCredentials({ doctorId }),
    ]);

    // Campanha cancelada entre o dispatch e o send -> não envia (defensivo:
    // não há endpoint de cancelamento de campanha hoje, o cancelamento real
    // é via job_cancel no dispatch — mas se um estado 'cancelada' surgir,
    // este caminho já o respeita).
    if (campaign?.status === 'cancelada') {
      await markEnvio(client, campaignId, leadId, 'falhou');
      await queue.complete({ jobId: job.id, workerId });
      return true;
    }
    // Lead removido entre o dispatch e o send -> marca 'falhou' e completa
    // (não é retry — o lead não vai "voltar"; o finalizador ainda fecha a
    // campanha).
    if (!lead) {
      await markEnvio(client, campaignId, leadId, 'falhou');
      await queue.complete({ jobId: job.id, workerId });
      return true;
    }
    if (!campaign || !credentials?.externalId || !credentials?.accessToken) {
      throw Object.assign(new Error('missing_resource'), { code: 'missing_resource' });
    }

    let blockedStatus = null;
    if (lead.doctor_id !== campaign.doctor_id || lead.doctor_id !== doctorId) blockedStatus = 'sem_autorizacao';
    else if (isPhoneIdentityReviewRequired(lead)) blockedStatus = 'phone_identity_review_required';
    else if (lead.whatsapp_authorization_status === 'opt_out') blockedStatus = 'opt_out';
    else if (lead.whatsapp_authorization_status !== 'autorizado') blockedStatus = 'sem_autorizacao';
    else if (!resolveCanonicalSendPhone(lead).ok) blockedStatus = 'invalid_recipient_phone';
    if (blockedStatus) {
      await markEnvio(client, campaignId, leadId, blockedStatus);
      await queue.complete({ jobId: job.id, workerId });
      return true;
    }

    // Template: revalida ANTES de reservar quota. Sem template pronto, nunca
    // dependemos da janela de 24h (isso é exclusivo do texto livre).
    let templateAtual = null;
    let doctorNome = null;
    if (campaign.modo_envio === 'template') {
      const { data: tmpl } = await client.from('whatsapp_templates').select('*').eq('id', campaign.whatsapp_template_id).maybeSingle();
      templateAtual = tmpl || null;
      if (!templateAtual || templateAtual.doctor_id !== campaign.doctor_id || !isTemplateReadyToSend(templateAtual)) {
        await markEnvio(client, campaignId, leadId, 'template_indisponivel');
        await queue.complete({ jobId: job.id, workerId });
        return true;
      }
      const { data: doc } = await client.from('doctors').select('nome').eq('id', campaign.doctor_id).maybeSingle();
      doctorNome = doc?.nome || null;
    } else {
      // Janela de 24h do WhatsApp: fora dela vira 'pendente_template' e o job
      // completa (não é falha, não reserva quota).
      const { data: lastInbound } = await client.from('conversations')
        .select('timestamp_msg').eq('lead_id', lead.id).eq('direcao', 'recebida')
        .order('timestamp_msg', { ascending: false }).limit(1).maybeSingle();
      if (!isWithinFreeTextWindow(lastInbound?.timestamp_msg)) {
        await markEnvio(client, campaign.id, lead.id, 'pendente_template');
        await queue.complete({ jobId: job.id, workerId });
        return true;
      }
    }

    // Reserva a quota ANTES da Meta. Mesma idempotency_key entre tentativas
    // do mesmo job -> a RPC devolve a reserva existente, nunca conta duas vezes.
    const reservation = await quota.reserve({
      organizationId: job.organization_id, category: 'whatsapp_messages',
      quantity: 1, idempotencyKey: `reserve:${job.id}`,
    });
    if (!reservation.allowed) throw Object.assign(new Error('quota_denied'), { code: 'quota_denied' });
    reservationId = reservation.reservationId;

    const { data: freshLead } = await client.from('leads').select(LEAD_SEND_SELECT).eq('id', leadId).maybeSingle();
    const destino = freshLead ? resolveCanonicalSendPhone(freshLead) : { ok: false };
    let finalBlock = null;
    if (!freshLead || freshLead.doctor_id !== campaign.doctor_id || freshLead.doctor_id !== doctorId) finalBlock = 'sem_autorizacao';
    else if (isPhoneIdentityReviewRequired(freshLead)) finalBlock = 'phone_identity_review_required';
    else if (freshLead.whatsapp_authorization_status === 'opt_out') finalBlock = 'opt_out';
    else if (freshLead.whatsapp_authorization_status !== 'autorizado') finalBlock = 'sem_autorizacao';
    else if (!destino.ok) finalBlock = 'invalid_recipient_phone';
    // Template ainda válido IMEDIATAMENTE antes do envio — refaz a LEITURA no
    // banco (nunca reusa o `templateAtual` capturado antes da reserva de
    // quota; entre os dois pontos passa uma chamada de RPC e a espera de
    // pacing, tempo real o bastante pra um sync concorrente ter mudado o
    // template). Também usa o dado mais recente pra montar os parâmetros.
    if (!finalBlock && campaign.modo_envio === 'template') {
      const { data: tmplNow } = await client.from('whatsapp_templates').select('*').eq('id', campaign.whatsapp_template_id).maybeSingle();
      if (!tmplNow || tmplNow.doctor_id !== campaign.doctor_id || !isTemplateReadyToSend(tmplNow)) {
        finalBlock = 'template_indisponivel';
      } else {
        templateAtual = tmplNow;
      }
    }
    if (finalBlock) {
      await quota.release({ reservationId });
      reservationId = null;
      await markEnvio(client, campaignId, leadId, finalBlock);
      await queue.complete({ jobId: job.id, workerId });
      return true;
    }

    await waitForSendSlot(doctorId, SEND_INTERVAL_MS());

    // Transição atômica pro estado "chamando a Meta agora" — a ÚLTIMA coisa
    // antes da chamada HTTP de verdade. Se perdermos a corrida (outra
    // execução já reivindicou, ou o envio já foi resolvido por outro
    // caminho), nunca chamamos a Meta: tratamos como "enviando abandonado".
    lockAcquired = await acquireSendLock(client, campaignId, leadId);
    if (!lockAcquired) {
      const { data: current } = await client.from('campanha_envios').select('status, envio_iniciado_em')
        .eq('campanha_id', campaignId).eq('lead_id', leadId).maybeSingle();
      if (current?.status === 'enviando' && current?.envio_iniciado_em) {
        const lockAgeMs = Date.now() - new Date(current.envio_iniciado_em).getTime();
        if (lockAgeMs >= SEND_LOCK_STALE_MS()) {
          // Trava mais velha que o teto configurado (bem maior que o timeout
          // HTTP da Meta) — só agora é seguro concluir que a execução dona
          // morreu no meio do envio e nunca resolveu o resultado. Nunca
          // sabemos se saiu — nunca reenviar, nunca retry automático. A
          // quota fica reservada (mesma cautela do resultado_desconhecido normal).
          await markEnvio(client, campaignId, leadId, 'resultado_desconhecido');
        }
        // Trava recente: outra execução (concorrente ou reclaim rápido)
        // muito provavelmente ainda está com a chamada à Meta em voo. Nunca
        // sobrescreve o resultado dela — não toca em campanha_envios, só
        // completa esta execução como no-op. Se ela também morrer, uma
        // futura reclamação encontrará a mesma trava já velha e resolverá.
      }
      // Se já é terminal, outro caminho já resolveu — não sobrescreve nada.
      await queue.complete({ jobId: job.id, workerId });
      return true;
    }

    if (campaign.modo_envio === 'template') {
      try {
        const parametros = renderTemplateBodyParameters(templateAtual.body_variable_count, campaign.template_variable_map, {
          leadNome: freshLead.nome, doctorNome,
        });
        const { messageId } = await sendTemplate(credentials.externalId, credentials.accessToken, destino.phone, {
          name: templateAtual.nome, languageCode: templateAtual.idioma, bodyParameters: parametros,
        });
        await quota.settle({ reservationId, actualQuantity: 1, estimatedCost: null, idempotencyKey: `settle:${job.id}` });
        await client.from('conversations').insert({
          lead_id: lead.id, canal: 'whatsapp', direcao: 'enviada',
          conteudo: templateAtual.body_text, origem: 'manual', timestamp_msg: new Date().toISOString(),
        });
        await markEnvio(client, campaign.id, lead.id, 'enviado', {
          enviado_em: new Date().toISOString(), message_id: messageId, meta_status: 'accepted',
        });
        await queue.complete({ jobId: job.id, workerId });
        return true;
      } catch (err) {
        if (err?.networkError) {
          // Timeout/desconexão após iniciar a requisição: nunca sabemos se a
          // Meta processou. Nunca reenviar silenciosamente — revisão manual,
          // sem retry automático, quota fica reservada (nunca liberada às cegas).
          log?.error({ err: { code: 'network_error' }, jobId: job.id }, 'Campaign template send: unknown result (network)');
          await markEnvio(client, campaignId, leadId, 'resultado_desconhecido');
          await queue.complete({ jobId: job.id, workerId });
          return true;
        }
        if (isPermanentTemplateError(err?.metaError?.code)) {
          // Erro permanente de template (ex.: 132001) — nunca vai funcionar
          // com retry; libera a quota (a Meta rejeitou antes de processar).
          const sanitizedCode = sanitizeMetaErrorCode(err.metaError);
          log?.error({ err: { code: sanitizedCode }, jobId: job.id }, 'Campaign template send: permanent template error');
          await quota.release({ reservationId }).catch(() => {});
          reservationId = null;
          await markEnvio(client, campaignId, leadId, 'falhou', { meta_error_code: sanitizedCode });
          await queue.complete({ jobId: job.id, workerId });
          return true;
        }
        throw err; // 5xx/rate-limit/outro -> cai no catch externo (retry/backoff existente)
      }
    }

    await send(credentials.externalId, credentials.accessToken, destino.phone, campaign.mensagem);
    await quota.settle({ reservationId, actualQuantity: 1, estimatedCost: null, idempotencyKey: `settle:${job.id}` });

    await client.from('conversations').insert({
      lead_id: lead.id, canal: 'whatsapp', direcao: 'enviada',
      conteudo: campaign.mensagem, origem: 'manual', timestamp_msg: new Date().toISOString(),
    });
    await markEnvio(client, campaign.id, lead.id, 'enviado', { enviado_em: new Date().toISOString() });
    await queue.complete({ jobId: job.id, workerId });
    return true;
  } catch (err) {
    const code = safeCode(err);
    if (reservationId && !lockAcquired) await quota.release({ reservationId }).catch(() => {});
    log?.error({ err: { code }, jobId: job.id }, 'Campaign send job failed');
    let result;
    try {
      result = await queue.retry({ jobId: job.id, workerId, errorCode: code, availableAt: retryAt(job.attempts, code) });
    } catch (retryErr) {
      log?.error({ err: { code: safeCode(retryErr) }, jobId: job.id }, 'Campaign send retry call failed');
      return false;
    }
    // dead_letter -> o destinatário nunca recebe: marca 'falhou' pra que o
    // finalizador consiga fechar a campanha.
    if (result?.status === 'dead_letter' && campaignId && leadId) {
      await markEnvio(client, campaignId, leadId, 'falhou').catch(() => {});
    } else if (lockAcquired && campaignId && leadId) {
      // Rejeição confirmada (nunca ambígua — resultado ambíguo nem chega
      // aqui, já completou como resultado_desconhecido acima) que AINDA vai
      // tentar de novo: libera a trava pra a PRÓXIMA tentativa conseguir
      // reivindicá-la. Nunca libera pra um crash puro (aí nada chama este
      // catch — a trava fica presa de propósito).
      await releaseSendLock(client, campaignId, leadId);
    }
    return false;
  }
}

const HANDLERS = {
  'campaign.dispatch': handleCampaignDispatchJob,
  'campaign.finalize': handleCampaignFinalizeJob,
  'campaign.send_message': handleCampaignSendJob,
};

export async function processCampaignJobs({ workerId, batchSize = 20, queue = jobQueue, quota = usageQuota, ...deps }) {
  // Best-effort: libera reservas órfãs de jobs mortos/dead_letter.
  if (typeof quota.sweepStaleReservations === 'function') {
    await Promise.resolve(quota.sweepStaleReservations()).catch(() => {});
  }
  const jobs = await queue.claim({
    workerId, batchSize, leaseSeconds: 300,
    jobTypes: ['campaign.dispatch', 'campaign.finalize', 'campaign.send_message'],
  });
  const results = await Promise.all((jobs || []).map((job) => {
    const h = HANDLERS[job.job_type];
    return h ? h(job, { workerId, queue, quota, ...deps }) : Promise.resolve(false);
  }));
  return {
    claimed: jobs?.length || 0,
    completed: results.filter(Boolean).length,
    retried: results.filter((x) => !x).length,
  };
}
