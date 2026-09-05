import { supabase } from './supabase.js';
import { rpcOrThrow } from './jobQueue.js';
export class UsageLedger {
  constructor(client = supabase) { this.client = client; }
  async aggregate({ organizationId, from, to }) {
    const data = await rpcOrThrow(this.client, 'usage_aggregate', {
      p_organization_id: organizationId,
      p_from: new Date(from).toISOString(),
      p_to: new Date(to).toISOString(),
    });
    return data || [];
  }
}
export const usageLedger = new UsageLedger();
