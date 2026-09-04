// FASE 2.3 — SHADOW READ da equipe.
//
// Decisão do proprietário: /team continua escrevendo SÓ em user_doctor_access
// (fonte de verdade legada). Sem dual-write. Quando TENANT_CORE_ENABLED=true,
// comparamos user_doctor_access com memberships e REGISTRAMOS divergências —
// nunca corrigimos, nunca promovemos papel, nunca alteramos a fonte de verdade.
//
// O cutover de equipe (migrar para memberships) é uma fase própria:
// docs/platform/23-team-membership-cutover.md

import { supabase } from './supabase.js';
import { env } from '../config/env.js';

// Compara os vínculos legados (user_doctor_access) de um doctor com as
// memberships da organização correspondente. Retorna um relatório de divergência
// e o registra via logger. NÃO tem efeito colateral no banco.
export async function shadowCompareTeam(req, doctorId) {
  if (env.TENANT_CORE_ENABLED !== 'true' || !doctorId) return null;

  const { data: map } = await supabase
    .from('organization_doctor_map')
    .select('organization_id')
    .eq('doctor_id', doctorId)
    .maybeSingle();
  const organizationId = map?.organization_id ?? null;
  if (!organizationId) {
    req.log?.warn({ doctorId }, 'team shadow-read: doctor sem organization_doctor_map');
    return { organizationId: null, doctorId, onlyLegacy: [], onlyMembership: [], match: false };
  }

  const [{ data: legacy }, { data: memberships }, { data: doctorRow }] = await Promise.all([
    supabase.from('user_doctor_access').select('user_id').eq('doctor_id', doctorId),
    supabase.from('memberships').select('user_id, role, status').eq('organization_id', organizationId),
    supabase.from('doctors').select('owner_user_id').eq('id', doctorId).maybeSingle(),
  ]);

  // O acesso legado a um doctor é user_doctor_access UNIÃO {owner_user_id} — o
  // dono da clínica não tem linha em user_doctor_access, mas É o organization_owner
  // no modelo novo. Sem incluí-lo, todo owner apareceria como falsa divergência.
  const legacyIds = new Set((legacy || []).map((r) => r.user_id));
  if (doctorRow?.owner_user_id) legacyIds.add(doctorRow.owner_user_id);
  const activeMembershipIds = new Set((memberships || []).filter((m) => m.status === 'active').map((m) => m.user_id));

  const onlyLegacy = [...legacyIds].filter((id) => !activeMembershipIds.has(id));
  const onlyMembership = [...activeMembershipIds].filter((id) => !legacyIds.has(id));
  const suspended = (memberships || []).filter((m) => m.status !== 'active' && legacyIds.has(m.user_id)).map((m) => m.user_id);

  const report = {
    organizationId,
    doctorId,
    legacyCount: legacyIds.size,
    membershipActiveCount: activeMembershipIds.size,
    onlyLegacy,
    onlyMembership,
    legacyButSuspendedMembership: suspended,
    match: onlyLegacy.length === 0 && onlyMembership.length === 0 && suspended.length === 0,
  };

  if (!report.match) {
    req.log?.warn(
      {
        organizationId,
        doctorId,
        onlyLegacy: onlyLegacy.length,
        onlyMembership: onlyMembership.length,
        suspendedDivergence: suspended.length,
      },
      'team shadow-read: divergência user_doctor_access x memberships (não corrigida)'
    );
  }
  return report;
}
