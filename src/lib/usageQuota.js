import { supabase } from './supabase.js';
import { rpcOrThrow as rpc } from './jobQueue.js';
export class UsageQuota {
  constructor(client = null) { this.client = client; }
  async reserve({ organizationId, category, quantity, idempotencyKey }) { const d = await rpc(this.client || supabase, 'usage_reserve', { p_organization_id: organizationId, p_category: category, p_quantity: quantity, p_idempotency_key: idempotencyKey }); return { allowed: d.allowed, reservationId: d.reservation_id, reason: d.reason ?? null }; }
  settle({ reservationId, actualQuantity, estimatedCost = null, idempotencyKey }) { return rpc(this.client || supabase, 'usage_settle', { p_reservation_id: reservationId, p_actual_quantity: actualQuantity, p_estimated_cost: estimatedCost, p_idempotency_key: idempotencyKey }); }
  release({ reservationId }) { return rpc(this.client || supabase, 'usage_release', { p_reservation_id: reservationId }); }
  // Libera reservas 'reserved' órfãs (job morto/dead_letter). Best-effort.
  sweepStaleReservations(olderThanSeconds = 86400) { return rpc(this.client || supabase, 'usage_reservations_sweep_stale', { p_older_than_seconds: olderThanSeconds }); }
}
export const usageQuota = new UsageQuota();
