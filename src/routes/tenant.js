import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { getShadowMetrics } from '../lib/tenantShadowRead.js';
import { isPlatformAdminUser } from '../lib/tenantContext.js';

const router = Router();
router.use(requireAuth);

// GET /tenant/context
// Devolve APENAS as organizações às quais o usuário tem membership ATIVA.
// Tudo é resolvido de novo no banco — nada de role/org/unit vindo do cliente.
// Não devolve tokens, segredos nem dados de outras organizações.
// Não escolhe organização silenciosamente quando há mais de uma.
router.get('/context', async (req, res) => {
  try {
    const userId = req.user.id;

    const [{ data: memberships, error: mErr }, { data: padmin, error: pErr }] = await Promise.all([
      supabase
        .from('memberships')
        .select('organization_id, role, status, organizations(id, name, status), membership_units(units(id, name, status))')
        .eq('user_id', userId)
        .eq('status', 'active'),
      supabase.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
    ]);
    if (mErr) throw mErr;
    if (pErr) throw pErr;

    const isPlatformAdmin = Boolean(padmin) || req.user.role === 'admin';

    // Só organizações ativas; membership suspensa/convidada já foi filtrada por status.
    const organizations = (memberships || [])
      .filter((m) => m.organizations && m.organizations.status === 'active')
      .map((m) => ({
        id: m.organization_id,
        name: m.organizations.name,
        role: m.role, // papel resolvido pelo banco, nunca do cliente
        units: (m.membership_units || [])
          .map((mu) => mu.units)
          .filter((u) => u && u.status === 'active')
          .map((u) => ({ id: u.id, name: u.name })),
      }));

    const requiresSelection = organizations.length > 1;
    // uma organização -> sugestão validável; nunca é autoridade final.
    const suggested = organizations.length === 1 ? organizations[0].id : null;

    res.json({
      organizations,
      is_platform_admin: isPlatformAdmin,
      requires_selection: requiresSelection,
      selected_organization_id: null, // a seleção vive no cliente; o backend só valida
      suggested_organization_id: suggested,
    });
  } catch (err) {
    req.log?.error({ err }, 'tenant context endpoint failed');
    res.status(500).json({ error: 'internal_error', requestId: req.id });
  }
});

// GET /tenant/shadow-metrics
// Endpoint EXPLICITAMENTE GLOBAL (não usa attachTenantContext): contadores
// acumulados do shadow-read de escopo (FASE 2.9). Só platform_admin. Não
// devolve IDs, PII nem organização — só números agregados desde o boot.
router.get('/shadow-metrics', async (req, res) => {
  if (!(await isPlatformAdminUser(req.user))) return res.status(403).json({ error: 'forbidden' });
  res.json(getShadowMetrics());
});

export default router;
