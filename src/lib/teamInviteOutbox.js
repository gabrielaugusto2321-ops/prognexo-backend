import { supabase } from './supabase.js';
import { TokenCipher, buildAad } from './credentialVault.js';

const safeErrorCode = (error) => {
  const candidate = error?.code || error?.name || 'email_delivery_failed';
  return String(candidate).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'email_delivery_failed';
};

export function retryAvailableAt(attemptCount, { baseMs = 1_000, maxMs = 60 * 60_000, random = Math.random } = {}) {
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attemptCount)));
  return new Date(Date.now() + Math.min(maxMs, exponential + Math.floor(random() * baseMs))).toISOString();
}

export async function processOutboxBatch({ workerId, batchSize = 10, adapter, client = supabase, leaseSeconds = 300 }) {
  const summary = { claimed: 0, sent: 0, retried: 0, errors: 0 };
  try {
    const { data: events, error } = await client.rpc('team_outbox_claim', {
      p_worker_id: workerId, p_batch_size: batchSize, p_lease_seconds: leaseSeconds,
    });
    if (error) throw error;
    summary.claimed = (events || []).length;
    await Promise.all((events || []).map(async (event) => {
      try {
        const aad = buildAad({ table: 'outbox_events', recordId: event.id, field: 'payload', scope: `org:${event.organization_id}`, provider: 'team_invite' });
        const payload = JSON.parse(TokenCipher.decrypt(event.payload, aad));
        // idempotency_key é ESTÁVEL entre tentativas do MESMO evento (nunca
        // muda em retry) — é o que permite ao Resend deduplicar se o
        // processo cair entre o provedor aceitar e mark_sent persistir
        // (entrega at-least-once, não exactly-once — ver comentário em
        // emailAdapter.js).
        await adapter.sendInvitationEmail({ ...payload, idempotencyKey: event.idempotency_key });
        const marked = await client.rpc('team_outbox_mark_sent', { p_event_id: event.id, p_worker_id: workerId });
        if (marked.error) throw marked.error;
        summary.sent += 1;
      } catch (error) {
        summary.errors += 1;
        const retry = await client.rpc('team_outbox_mark_retry', {
          p_event_id: event.id,
          p_worker_id: workerId,
          p_error_code: safeErrorCode(error),
          p_available_at: retryAvailableAt(event.attempt_count),
        });
        if (!retry.error) summary.retried += 1;
      }
    }));
  } catch {
    summary.errors += 1;
  }
  return summary;
}
