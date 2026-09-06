import { supabase } from './supabase.js';
import { env } from '../config/env.js';
import { shadowCompareScope } from './tenantShadowRead.js';

// Resolvedor central de contexto de tenant (FASE 2.1).
//
// Regras:
//  - `organization_id` NUNCA vem do body. Só do header `X-Organization-Id` ou
//    da única membership ATIVA do usuário.
//  - organização é derivada de uma membership ATIVA e autorizada.
//  - sem fallback silencioso para "o primeiro tenant".
//  - usuário com >1 organização precisa selecionar uma (header) — senão 409.
//  - FASE 2.9: platform_admin numa rota tenant-scoped NÃO opera "global".
//    Sem organização selecionada -> 409 organization_selection_required.
//    Organização selecionada -> fica LIMITADO àquela organização (mesmo
//    escopo de doctor que um membro comum). Acesso global só existe em
//    endpoint administrativo explicitamente global (que não usa este
//    middleware — ex.: POST /doctors, GET /tenant/shadow-metrics).
//  - FASE 2.9: organização sem `organization_doctor_map` (invariante de
//    compat quebrada) -> 409 tenant_backfill_required, para NINGUÉM
//    (nem platform_admin) — nunca "vê tudo".
//
// Enquanto `TENANT_CORE_ENABLED=false`, o middleware não bloqueia nada — só
// anexa `req.tenant = { enabled:false }` e as rotas seguem pelo caminho antigo.

// Helper reutilizável para endpoints EXPLICITAMENTE globais (não passam pelo
// attachTenantContext): confirma se o usuário é admin de plataforma.
export async function isPlatformAdminUser(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const { data } = await supabase
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  return Boolean(data);
}

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

  // FASE 2.9 — platform_admin sem organização selecionada numa rota
  // tenant-scoped PRECISA selecionar (nunca opera global aqui).
  if (!organizationId) {
    return { ok: false, code: 'organization_selection_required', status: 409 };
  }

  // Compat: `doctorId` vem do organization_doctor_map. FASE 2.9 — sem essa
  // linha a organização não está pronta para o cutover: 409 para TODOS
  // (inclusive platform_admin), nunca degrada para "vê tudo".
  const { data: map } = await supabase
    .from('organization_doctor_map')
    .select('doctor_id, default_unit_id')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (!map || !map.doctor_id) {
    return { ok: false, code: 'tenant_backfill_required', status: 409 };
  }
  const doctorId = map.doctor_id;
  const defaultUnitId = map.default_unit_id ?? null;

  const unitIds = (membership?.membership_units || []).map((u) => u.unit_id);

  // X-Unit-Id: precisa pertencer à organização selecionada. Para membro comum,
  // precisa estar entre as unidades da membership; para platform_admin, basta
  // pertencer à organização. Divergência -> 403 (nunca ignora silenciosamente).
  let unitId = null;
  if (requestedUnit) {
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
//  - tenant core ON   -> SEMPRE [doctorId] da organização selecionada. O
//    middleware já garante que `doctorId` existe (senão 409). Não há mais
//    caminho "null = vê tudo" — nem para platform_admin.
export async function scopedDoctorIds(req, getScopedDoctorIds) {
  if (req.tenant?.enabled) {
    const ids = req.tenant.doctorId ? [req.tenant.doctorId] : [];
    // FASE 2.9 — shadow-read: compara com o legado e registra divergências.
    // Não altera `ids` (a decisão de acesso continua sendo o contexto novo).
    return shadowCompareScope(req, ids);
  }
  return getScopedDoctorIds(req.user);
}

// Compat: o request tem acesso a este doctor_id?
export async function tenantAllowsDoctor(req, doctorId, getScopedDoctorIds) {
  if (req.tenant?.enabled) {
    // Limitado à organização selecionada — platform_admin incluído.
    return req.tenant.doctorId === doctorId;
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
