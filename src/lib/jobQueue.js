import crypto from 'node:crypto';
import { supabase } from './supabase.js';
import { TokenCipher, buildAad } from './credentialVault.js';

// Preserva o código estável do `raise exception 'codigo'` da RPC como
// `err.code`/`err.message` (a mensagem crua do Postgres para um raise sem
// detalhe É só o código) — sem isso, o mapeamento de erro nas rotas
// (mesmo padrão de `rpcErrorResponse` em team.js) fica impossível. `cause`
// guarda o objeto de erro completo do supabase-js para o log.
export async function rpcOrThrow(client, name, params) {
  const { data, error } = await client.rpc(name, params);
  if (error) {
    const code = (error.message || '').split('\n')[0].trim() || `${name}_failed`;
    throw Object.assign(new Error(code), { code, rpc: name, cause: error });
  }
  return data;
}
const rpc = rpcOrThrow;
export class JobQueue {
  constructor(client = null) { this.client = client; }
  async enqueue(type, payload, { organizationId = null, unitId = null, idempotencyKey, priority = 0, runAt = new Date(), maxAttempts = 5, sensitive = false } = {}) {
    const id = crypto.randomUUID();
    const plain = JSON.stringify(payload ?? {});
    const aad = buildAad({ table: 'job_queue', recordId: id, field: 'payload', scope: organizationId ? `org:${organizationId}` : 'global', provider: type });
    const stored = sensitive ? TokenCipher.encrypt(plain, aad) : plain;
    return rpc(this.client || supabase, 'job_enqueue', { p_id: id, p_organization_id: organizationId, p_unit_id: unitId, p_job_type: type, p_payload: stored, p_idempotency_key: idempotencyKey, p_priority: priority, p_available_at: new Date(runAt).toISOString(), p_max_attempts: maxAttempts });
  }
  claim({ workerId, batchSize = 10, leaseSeconds = 300, jobTypes = null }) { return rpc(this.client || supabase, 'job_claim', { p_worker_id: workerId, p_batch_size: batchSize, p_lease_seconds: leaseSeconds, p_job_types: jobTypes }); }
  heartbeat({ jobId, workerId, leaseSeconds = 300 }) { return rpc(this.client || supabase, 'job_heartbeat', { p_job_id: jobId, p_worker_id: workerId, p_lease_seconds: leaseSeconds }); }
  complete({ jobId, workerId }) { return rpc(this.client || supabase, 'job_complete', { p_job_id: jobId, p_worker_id: workerId }); }
  retry({ jobId, workerId, errorCode, availableAt = new Date() }) { return rpc(this.client || supabase, 'job_retry', { p_job_id: jobId, p_worker_id: workerId, p_error_code: errorCode, p_available_at: new Date(availableAt).toISOString() }); }
  cancel({ organizationId, actorUserId, jobId }) { return rpc(this.client || supabase, 'job_cancel', { p_organization_id: organizationId, p_actor_user_id: actorUserId, p_job_id: jobId }); }
  decodePayload(job, { sensitive = false } = {}) {
    const aad = buildAad({ table: 'job_queue', recordId: job.id, field: 'payload', scope: job.organization_id ? `org:${job.organization_id}` : 'global', provider: job.job_type });
    return JSON.parse(sensitive ? TokenCipher.decrypt(job.payload, aad) : job.payload);
  }

  // FASE 2.8 (revisão) — cria o par (campanha_envios, job_queue) de UM
  // destinatário ATOMICAMENTE via RPC transacional. Substitui
  // enqueue + upsert separados (que não eram atômicos). idempotency_key é
  // derivada no Postgres (`campanha:lead`), nunca passada daqui.
  async enqueueCampaignRecipient({ campaignId, leadId, doctorId, organizationId }) {
    const id = crypto.randomUUID();
    const aad = buildAad({ table: 'job_queue', recordId: id, field: 'payload', scope: `org:${organizationId}`, provider: 'campaign.send_message' });
    const encrypted = TokenCipher.encrypt(JSON.stringify({ campaignId, leadId, doctorId }), aad);
    return rpc(this.client || supabase, 'campaign_recipient_enqueue', {
      p_job_id: id, p_organization_id: organizationId, p_campaign_id: campaignId, p_lead_id: leadId, p_payload_encrypted: encrypted,
    });
  }
}
export const jobQueue = new JobQueue();
