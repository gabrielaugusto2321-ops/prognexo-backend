import { supabase } from './supabase.js';
import { getScopedDoctorIds } from '../middleware/auth.js';

function pathValue(row, path) { return path.split('.').reduce((v, key) => v?.[key], row); }
export async function authorizeResource({ user, table, id, ownerPath = 'doctor_id', requireOwnerForCloser = false, select = '*' }) {
  const { data: row, error } = await supabase.from(table).select(select).eq('id', id).maybeSingle();
  if (error || !row) return { ok: false, row: null, reason: 'not_found' };
  if (user.role === 'admin') return { ok: true, row };
  const doctorId = pathValue(row, ownerPath);
  const scoped = await getScopedDoctorIds(user);
  if (!doctorId || !scoped?.includes(doctorId)) return { ok: false, row, reason: 'forbidden' };
  if (user.role === 'closer' && requireOwnerForCloser) {
    const owner = row.sdr_responsavel_id ?? row.responsavel_id ?? row.leads?.sdr_responsavel_id;
    if (owner !== user.id) return { ok: false, row, reason: 'forbidden' };
  }
  return { ok: true, row };
}
export async function assertRelatedBelongs({ table, id, doctorId, ownerPath = 'doctor_id' }) {
  if (!id) return { ok: true, row: null };
  const { data: row, error } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  return { ok: !error && row && pathValue(row, ownerPath) === doctorId, row };
}
export async function assertUserAccess({ userId, doctorId }) {
  const { data: doctor } = await supabase.from('doctors').select('owner_user_id').eq('id', doctorId).maybeSingle();
  if (doctor?.owner_user_id === userId) return true;
  const { data } = await supabase.from('user_doctor_access').select('user_id').eq('user_id', userId).eq('doctor_id', doctorId).maybeSingle();
  return Boolean(data);
}
