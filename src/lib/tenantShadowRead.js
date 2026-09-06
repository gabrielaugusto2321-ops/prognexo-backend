// FASE 2.9 — SHADOW READ do escopo de tenant.
//
// Em cada leitura escopada do corte vertical (`scopedDoctorIds`), quando
// TENANT_CORE_ENABLED=true E TENANT_SHADOW_READ_ENABLED=true, comparamos:
//
//   - escopo NOVO   = contexto de tenant (membership ativa + organization_doctor_map)
//   - escopo LEGADO = getScopedDoctorIds(user) (owner_user_id / user_doctor_access)
//
// e REGISTRAMOS as divergências. Nunca mudamos a decisão de acesso (o request
// continua usando o escopo NOVO), nunca chamamos serviço externo, nunca
// duplicamos efeito colateral. Só contadores em processo + log sem PII.
//
// Métricas (contadores acumulados desde o boot):
//   onlyLegacy        - doctor_id que só o legado enxerga (membership revogada
//                       mas user_doctor_access/owner remanescente)
//   onlyOrganization  - doctor_id que só o contexto novo enxerga (membership
//                       ativa sem vínculo legado correspondente)
//   membershipMismatch- houve qualquer diferença entre os dois conjuntos
//   missingMap        - organização ativa sem organization_doctor_map (doctorId
//                       novo = vazio, mas o legado enxerga algo)
//   unitMismatch      - X-Unit-Id resolvido não está entre as unidades da
//                       membership (só platform_admin chega aqui)
//   comparisons       - total de comparações feitas
//   divergences       - comparações com pelo menos uma divergência

import { env } from '../config/env.js';
import { getScopedDoctorIds } from '../middleware/auth.js';

const counters = {
  comparisons: 0,
  divergences: 0,
  onlyLegacy: 0,
  onlyOrganization: 0,
  membershipMismatch: 0,
  missingMap: 0,
  unitMismatch: 0,
};

export function getShadowMetrics() {
  return { ...counters };
}

// só para testes — zera os contadores.
export function __resetShadowMetricsForTests() {
  for (const k of Object.keys(counters)) counters[k] = 0;
}

function setDiff(a, b) {
  return [...a].filter((x) => !b.has(x));
}

// `tenantIds`: array | null já resolvido pelo contexto novo (null = vê tudo).
// Retorna sempre o próprio `tenantIds` (a decisão de acesso NÃO muda).
export async function shadowCompareScope(req, tenantIds) {
  if (env.TENANT_SHADOW_READ_ENABLED !== 'true' || !req?.tenant?.enabled) return tenantIds;
  try {
    const legacy = await getScopedDoctorIds(req.user);
    counters.comparisons += 1;

    // null de qualquer lado = "vê tudo": só registra se os dois lados divergem
    // nesse aspecto (um irrestrito, o outro restrito).
    const legacyAll = legacy == null;
    const tenantAll = tenantIds == null;
    if (legacyAll || tenantAll) {
      if (legacyAll !== tenantAll) {
        counters.divergences += 1;
        counters.membershipMismatch += 1;
        req.log?.warn(
          { scope: 'tenant-shadow-read', legacyUnrestricted: legacyAll, tenantUnrestricted: tenantAll },
          'tenant shadow-read: um lado irrestrito, o outro não',
        );
      }
      return tenantIds;
    }

    const legacySet = new Set(legacy);
    const tenantSet = new Set(tenantIds);
    const onlyLegacy = setDiff(legacySet, tenantSet);
    const onlyOrganization = setDiff(tenantSet, legacySet);

    if (onlyLegacy.length === 0 && onlyOrganization.length === 0) return tenantIds;

    counters.divergences += 1;
    counters.membershipMismatch += 1;
    if (onlyLegacy.length) counters.onlyLegacy += onlyLegacy.length;
    if (onlyOrganization.length) counters.onlyOrganization += onlyOrganization.length;
    // contexto novo vazio + legado com algo = provável falta de map
    if (tenantIds.length === 0 && legacy.length > 0 && req.tenant.organizationId) {
      counters.missingMap += 1;
    }
    // X-Unit-Id resolvido fora das unidades da membership (platform_admin).
    if (req.tenant.unitId && Array.isArray(req.tenant.unitIds) && !req.tenant.unitIds.includes(req.tenant.unitId)) {
      counters.unitMismatch += 1;
    }

    req.log?.warn(
      {
        scope: 'tenant-shadow-read',
        organizationId: req.tenant.organizationId,
        onlyLegacy: onlyLegacy.length,
        onlyOrganization: onlyOrganization.length,
      },
      'tenant shadow-read: divergência de escopo legado x organização (não corrigida)',
    );
    return tenantIds;
  } catch (err) {
    // shadow-read nunca pode quebrar o request.
    req.log?.error({ err, scope: 'tenant-shadow-read' }, 'tenant shadow-read falhou (ignorado)');
    return tenantIds;
  }
}
