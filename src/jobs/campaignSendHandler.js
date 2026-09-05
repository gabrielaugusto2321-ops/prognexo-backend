import { supabase } from '../lib/supabase.js';
import { sendWhatsAppMessage } from '../lib/whatsapp.js';
import { CredentialVault } from '../lib/credentialVault.js';
import { jobQueue } from '../lib/jobQueue.js';
import { usageQuota } from '../lib/usageQuota.js';

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

const DISPATCH_BATCH = 500;
const FINALIZE_MAX_ATTEMPTS = 200; // ~3.3h de poll a 60s antes de dead_letter

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

    // Paginação estável por leads.id (uuid — ordem arbitrária mas
    // determinística; `id > cursor` varre tudo uma vez).
    let cursor = null;
    for (;;) {
      let q = client.from('leads').select('id').eq('doctor_id', campaign.doctor_id).order('id', { ascending: true }).limit(batchSize);
      if (campaign.filtro_status) q = q.eq('status_atual', campaign.filtro_status);
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
export async function handleCampaignSendJob(job, {
  workerId, client = supabase, queue = jobQueue, quota = usageQuota,
  send = sendWhatsAppMessage, credentialVault = CredentialVault, log,
} = {}) {
  let reservationId;
  let externalStarted = false;
  let campaignId;
  let leadId;
  try {
    let doctorId;
    ({ campaignId, leadId, doctorId } = queue.decodePayload(job, { sensitive: true }));
    const [{ data: campaign }, { data: lead }, integration] = await Promise.all([
      client.from('campanhas').select('*').eq('id', campaignId).single(),
      client.from('leads').select('id,telefone').eq('id', leadId).maybeSingle(),
      credentialVault.readIntegrationCredentials({ doctorId, gateway: 'whatsapp' }),
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
    if (!campaign || !integration?.external_id || !integration?.access_token) {
      throw Object.assign(new Error('missing_resource'), { code: 'missing_resource' });
    }

    // Janela de 24h do WhatsApp: fora dela vira 'pendente_template' e o job
    // completa (não é falha, não reserva quota).
    const { data: lastInbound } = await client.from('conversations')
      .select('timestamp_msg').eq('lead_id', lead.id).eq('direcao', 'recebida')
      .order('timestamp_msg', { ascending: false }).limit(1).maybeSingle();
    const dentroDaJanela = lastInbound && Date.now() - new Date(lastInbound.timestamp_msg).getTime() < 24 * 60 * 60 * 1000;
    if (!dentroDaJanela) {
      await markEnvio(client, campaign.id, lead.id, 'pendente_template');
      await queue.complete({ jobId: job.id, workerId });
      return true;
    }

    // Reserva a quota ANTES da Meta. Mesma idempotency_key entre tentativas
    // do mesmo job -> a RPC devolve a reserva existente, nunca conta duas vezes.
    const reservation = await quota.reserve({
      organizationId: job.organization_id, category: 'whatsapp_messages',
      quantity: 1, idempotencyKey: `reserve:${job.id}`,
    });
    if (!reservation.allowed) throw Object.assign(new Error('quota_denied'), { code: 'quota_denied' });
    reservationId = reservation.reservationId;

    externalStarted = true; // a partir daqui a mensagem PODE ter saído — nunca liberamos a reserva
    await send(integration.external_id, integration.access_token, lead.telefone, campaign.mensagem);
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
    if (reservationId && !externalStarted) await quota.release({ reservationId }).catch(() => {});
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
