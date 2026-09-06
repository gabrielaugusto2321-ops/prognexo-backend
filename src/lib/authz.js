import { supabase } from './supabase.js';
import { getScopedDoctorIds } from '../middleware/auth.js';

function pathValue(row, path) { return path.split('.').reduce((v, key) => v?.[key], row); }

// FASE 2.9 — escopo de doctor_id que ESTE request pode enxergar/mutar.
//  - tenant core OFF  -> caminho legado (getScopedDoctorIds pelo user).
//  - tenant core ON   -> SEMPRE [doctorId] da organização selecionada.
//    `attachTenantContext` já garante `doctorId` (senão 409). NUNCA cai de
//    volta no legado, NUNCA retorna `null` (vê tudo) — nem para platform_admin.
async function resolveScope(req, user) {
  if (req?.tenant?.enabled) {
    return req.tenant.doctorId ? [req.tenant.doctorId] : [];
  }
  return getScopedDoctorIds(user);
}

// `req` é opcional só para compatibilidade com chamadas legadas/tests; todas as
// rotas do corte vertical passam `req` (elas montam `attachTenantContext`).
export async function authorizeResource({ req, user: userArg, table, id, ownerPath = 'doctor_id', requireOwnerForCloser = false, select = '*' }) {
  const user = userArg ?? req?.user;
  const { data: row, error } = await supabase.from(table).select(select).eq('id', id).maybeSingle();
  if (error || !row) return { ok: false, row: null, reason: 'not_found' };

  // Com tenant core ON, "admin legado" não é mais um bypass — o platform_admin
  // fica limitado à organização selecionada (resolveScope nunca devolve `null`),
  // e attachTenantContext já barra "sem org"/"org sem map" com 409.
  if (!req?.tenant?.enabled && user.role === 'admin') return { ok: true, row };

  const doctorId = pathValue(row, ownerPath);
  const scoped = await resolveScope(req, user);
  if (!doctorId || (scoped && !scoped.includes(doctorId))) return { ok: false, row, reason: 'forbidden' };

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

// `req` opcional: com tenant core ON, além do vínculo legado exige que o
// usuário alvo tenha membership ATIVA na organização do contexto — assim uma
// linha remanescente em user_doctor_access não reautoriza sozinha.
export async function assertUserAccess({ req, userId, doctorId }) {
  const { data: doctor } = await supabase.from('doctors').select('owner_user_id').eq('id', doctorId).maybeSingle();
  const legacyOk = doctor?.owner_user_id === userId
    || Boolean((await supabase.from('user_doctor_access').select('user_id').eq('user_id', userId).eq('doctor_id', doctorId).maybeSingle()).data);

  if (!req?.tenant?.enabled) return legacyOk;
  if (!req.tenant.organizationId) return legacyOk && Boolean(doctor);

  const { data: membership } = await supabase
    .from('memberships')
    .select('id')
    .eq('user_id', userId)
    .eq('organization_id', req.tenant.organizationId)
    .eq('status', 'active')
    .maybeSingle();
  return legacyOk && Boolean(membership);
}
