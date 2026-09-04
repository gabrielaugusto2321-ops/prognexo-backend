import { supabase } from './supabase.js';
import { env } from '../config/env.js';

// Resolvedor central de contexto de tenant (FASE 2.1).
//
// Regras:
//  - `organization_id` NUNCA vem do body. Só do header `X-Organization-Id` ou
//    da única membership ativa do usuário.
//  - organização é derivada de uma membership ATIVA e autorizada.
//  - sem fallback silencioso para "o primeiro tenant".
//  - usuário com >1 organização precisa selecionar uma (header) — senão 409.
//  - platform_admin é tratado explicitamente.
//  - compatibilidade: `doctorId` é resolvido pelo `organization_doctor_map`.
//
// Enquanto `TENANT_CORE_ENABLED=false`, o middleware não bloqueia nada — só
// anexa `req.tenant = { enabled:false }` e as rotas seguem pelo caminho antigo.

export async function resolveTenantContext(req) {
  const user = req.user; // vem do requireAuth
  if (!user) return { ok: false, code: 'no_user', status: 401 };

  const requestedOrg =
    req.get('X-Organization-Id') ||
    (typeof req.query.organization_id === 'string' ? req.query.organization_id : null);
  const requestedUnit = req.get('X-Unit-Id') || null;
  // body é explicitamente ignorado — org e unit só por header/query.

  const [{ data: memberships, error: mErr }, { data: padmin }] = await Promise.all([
    supabase
      .from('memberships')
      .select('id, organization_id, role, status, membership_units(unit_id)')
      .eq('user_id', user.id)
      .eq('status', 'active'),
    supabase.from('platform_admins').select('user_id').eq('user_id', user.id).maybeSingle(),
  ]);
  if (mErr) throw mErr;

  const isPlatformAdmin = Boolean(padmin) || user.role === 'admin';
  const active = memberships || [];

  let membership = null;
  if (requestedOrg) {
    membership = active.find((m) => m.organization_id === requestedOrg) || null;
    if (!membership && !isPlatformAdmin) {
      return { ok: false, code: 'no_membership_for_org', status: 403 };
    }
  } else if (active.length === 1) {
    membership = active[0];
  } else if (active.length > 1) {
    return { ok: false, code: 'organization_selection_required', status: 409 };
  }

  if (!membership && !isPlatformAdmin) {
    return { ok: false, code: 'no_active_membership', status: 403 };
  }

  const organizationId = membership?.organization_id ?? requestedOrg ?? null;

  // platform_admin sem org selecionada: contexto "global" (sem doctorId).
  let doctorId = null;
  let defaultUnitId = null;
  if (organizationId) {
    const { data: map } = await supabase
      .from('organization_doctor_map')
      .select('doctor_id, default_unit_id')
      .eq('organization_id', organizationId)
      .maybeSingle();
    doctorId = map?.doctor_id ?? null;
    defaultUnitId = map?.default_unit_id ?? null;
  }

  const unitIds = (membership?.membership_units || []).map((u) => u.unit_id);

  // X-Unit-Id: precisa pertencer à organização selecionada. Para membro comum,
  // precisa estar entre as unidades da membership; para platform_admin, basta
  // pertencer à organização. Divergência -> 403 (nunca ignora silenciosamente).
  let unitId = null;
  if (requestedUnit) {
    if (!organizationId) return { ok: false, code: 'unit_requires_organization', status: 409 };
    let unitOk = unitIds.includes(requestedUnit);
    if (!unitOk && isPlatformAdmin) {
      const { data: u } = await supabase
        .from('units')
        .select('id')
        .eq('id', requestedUnit)
        .eq('organization_id', organizationId)
        .maybeSingle();
      unitOk = Boolean(u);
    }
    if (!unitOk) return { ok: false, code: 'unit_not_in_organization', status: 403 };
    unitId = requestedUnit;
  }

  return {
    ok: true,
    enabled: true,
    userId: user.id,
    organizationId,
    doctorId, // compat legado
    defaultUnitId,
    unitId, // unidade explicitamente selecionada e validada (ou null)
    role: membership?.role ?? (isPlatformAdmin ? 'platform_admin' : null),
    isPlatformAdmin,
    unitIds,
    organizationIds: active.map((m) => m.organization_id),
  };
}

// Compat: quais doctor_id o request pode enxergar.
//  - tenant core OFF  -> caminho antigo (getScopedDoctorIds).
//  - tenant core ON   -> deriva do contexto (map). null = platform_admin sem org (vê tudo).
export async function scopedDoctorIds(req, getScopedDoctorIds) {
  if (req.tenant?.enabled) {
    if (req.tenant.isPlatformAdmin && !req.tenant.doctorId) return null;
    return req.tenant.doctorId ? [req.tenant.doctorId] : [];
  }
  return getScopedDoctorIds(req.user);
}

// Compat: o request tem acesso a este doctor_id?
export async function tenantAllowsDoctor(req, doctorId, getScopedDoctorIds) {
  if (req.tenant?.enabled) {
    return req.tenant.isPlatformAdmin || req.tenant.doctorId === doctorId;
  }
  const ids = await getScopedDoctorIds(req.user);
  return !ids || ids.includes(doctorId);
}

// Middleware: roda DEPOIS do requireAuth nas rotas do corte vertical.
export async function attachTenantContext(req, res, next) {
  if (env.TENANT_CORE_ENABLED !== 'true') {
    req.tenant = { ok: true, enabled: false };
    return next();
  }
  try {
    const ctx = await resolveTenantContext(req);
    if (!ctx.ok) {
      return res.status(ctx.status || 403).json({ error: ctx.code });
    }
    req.tenant = ctx;
    next();
  } catch (err) {
    req.log?.error({ err }, 'tenant context resolution failed');
    res.status(500).json({ error: 'internal_error', requestId: req.id });
  }
}
