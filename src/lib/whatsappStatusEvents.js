// FASE 2 — processamento idempotente dos webhooks de status da Meta
// (sent/delivered/read/failed). Localiza pelo `message_id` gravado em
// `campanha_envios` no momento do envio (ver handleCampaignSendJob /
// processarEnvioCampanha). Nunca lança para status desconhecido nem para
// message_id não encontrado — os dois casos são sinalizados só por log
// sanitizado (nunca 500), porque um evento de status é sempre best-effort:
// perder um não pode derrubar o webhook nem gerar retry destrutivo.

// Transições monotônicas: accepted -> sent -> delivered -> read. Um evento
// atrasado (rank menor ou igual ao atual) nunca "rebaixa" o status.
const STATUS_RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 };
const KNOWN_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

export async function applyWhatsAppStatusEvent({ supabase, messageId, status, errorCode = null, log }) {
  if (!messageId) {
    log?.warn({ code: 'missing_message_id' }, 'WhatsApp status webhook: evento sem message_id ignorado');
    return { applied: false, reason: 'missing_message_id' };
  }
  if (!KNOWN_STATUSES.has(status)) {
    // Nunca inclui o valor bruto recebido no log — só o fato de ser desconhecido.
    log?.warn({ code: 'unknown_status' }, 'WhatsApp status webhook: status desconhecido ignorado');
    return { applied: false, reason: 'unknown_status' };
  }

  const { data: envio, error: findErr } = await supabase
    .from('campanha_envios')
    .select('id, meta_status')
    .eq('message_id', messageId)
    .maybeSingle();
  if (findErr) {
    log?.error({ code: 'status_lookup_failed' }, 'WhatsApp status webhook: falha ao buscar campanha_envios');
    return { applied: false, reason: 'lookup_failed' };
  }
  if (!envio) {
    // Nunca é erro 500 — mensagem enviada fora de uma campanha (ou de uma
    // instalação anterior à FASE 2) não tem `message_id` no ledger.
    log?.warn({ code: 'message_id_not_found' }, 'WhatsApp status webhook: message_id não encontrado no ledger');
    return { applied: false, reason: 'not_found' };
  }

  // failed é terminal — nada muda depois dele.
  if (envio.meta_status === 'failed') return { applied: false, reason: 'terminal_failed' };

  if (status === 'failed') {
    // Um "failed" tardio nunca rebaixa um estado de sucesso já mais avançado
    // (ex.: já vimos 'read' e agora chega um 'failed' fora de ordem).
    if (envio.meta_status === 'read') return { applied: false, reason: 'late_event_ignored' };
    await supabase.from('campanha_envios').update({
      meta_status: 'failed', meta_status_at: new Date().toISOString(),
      meta_error_code: errorCode != null ? String(errorCode) : null,
    }).eq('id', envio.id);
    return { applied: true };
  }

  const currentRank = STATUS_RANK[envio.meta_status] ?? -1;
  const newRank = STATUS_RANK[status];
  if (newRank <= currentRank) return { applied: false, reason: 'late_or_duplicate' };

  await supabase.from('campanha_envios').update({
    meta_status: status, meta_status_at: new Date().toISOString(),
  }).eq('id', envio.id);
  return { applied: true };
}
