import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';
import { attachTenantContext } from '../lib/tenantContext.js';
import { shadowCompareTeam } from '../lib/teamShadowRead.js';
import { teamMutationLimiter } from '../middleware/rateLimits.js';
import { env } from '../config/env.js';

const router = Router();
router.use(requireAuth);
router.use(attachTenantContext); // no-op se TENANT_CORE_ENABLED=false

// FASE 2.6 — papéis de membership (nunca em users.role, que é travado em
// admin/doctor/closer). Ver docs/platform/23-team-memberships-cutover-audit.md.
const MEMBERSHIP_ROLES = [
  'organization_owner', 'organization_admin', 'manager',
  'closer', 'receptionist', 'professional', 'financial', 'viewer',
];
const MANAGER_ROLES = new Set(['organization_owner', 'organization_admin']);

// true só quando a flag está ligada E o contexto de tenant resolveu uma
// organização (sem isso não há onde ler/escrever memberships). Se
// TENANT_CORE_ENABLED=false, req.tenant.enabled já é false — degrada pro
// legado automaticamente, sem checagem extra.
function membershipsOn(req) {
  return env.TEAM_MEMBERSHIPS_ENABLED === 'true' && Boolean(req.tenant?.enabled) && Boolean(req.tenant?.organizationId);
}

function isTeamManager(req) {
  if (membershipsOn(req)) {
    return req.tenant.isPlatformAdmin || MANAGER_ROLES.has(req.tenant.role);
  }
  return req.user.role === 'doctor' || req.user.role === 'admin';
}

function requireTeamManager(req, res, next) {
  if (!isTeamManager(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// Mapa de erro de RPC (mensagem do `raise exception`) -> status HTTP.
// Nunca vaza detalhe interno; a mensagem já É o código estável.
const RPC_ERROR_STATUS = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  invalid_role: 400,
  invalid_status: 400,
  unit_not_in_organization: 400,
  last_owner_protected: 409,
};
function rpcErrorResponse(res, req, err) {
  const code = err?.message?.split('\n')[0]?.trim();
  const status = RPC_ERROR_STATUS[code];
  if (status) return res.status(status).json({ error: code });
  // Deadlock real do Postgres (SQLSTATE 40P01) — pode acontecer quando dois
  // owners diferentes são alterados ao mesmo tempo (o lock ordenado do
  // último-owner ainda pode colidir com o lock inicial da linha-alvo). O
  // Postgres já garantiu que NENHUM dos dois corrompeu o estado (um dos dois
  // é abortado inteiro) — é seguro pedir pro cliente tentar de novo.
  if (err?.code === '40P01' || /deadlock detected/i.test(err?.message || '')) {
    return res.status(409).json({ error: 'concurrent_update' });
  }
  req.log?.error({ err }, 'team RPC failed');
  return res.status(500).json({ error: 'internal_error', requestId: req.id });
}

const addSchema = z.object({
  nome: z.string().trim().min(1),
  email: z.string().trim().email(),
  role: z.enum(MEMBERSHIP_ROLES),
  unit_ids: z.array(z.string().uuid()).max(50).optional().default([]),
}).strict();
const roleSchema = z.object({ role: z.enum(MEMBERSHIP_ROLES) }).strict();
const statusSchema = z.object({ status: z.enum(['active', 'suspended']) }).strict();
const unitsSchema = z.object({ unit_ids: z.array(z.string().uuid()).max(50) }).strict();

// ===========================================================================
// GET /team?doctor_id= (legado) — sob a flag, organization_id vem só do
// tenantContext (nunca do query/body); lista as memberships da organização.
// ===========================================================================
router.get('/', requireTeamManager, async (req, res) => {
  if (membershipsOn(req)) {
    const organizationId = req.tenant.organizationId;

    const { data: memberships, error } = await supabase
      .from('memberships')
      .select('id, user_id, role, status, users(id, nome, email, ativo, criado_em), membership_units(units(id, name))')
      .eq('organization_id', organizationId);
    if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }

    const { data: map } = await supabase
      .from('organization_doctor_map')
      .select('doctor_id')
      .eq('organization_id', organizationId)
      .maybeSingle();
    const doctorId = map?.doctor_id ?? null;

    let distribuicao_automatica = false;
    let contagem = {};
    if (doctorId) {
      const { data: doctorRow } = await supabase.from('doctors').select('distribuicao_automatica').eq('id', doctorId).single();
      distribuicao_automatica = doctorRow?.distribuicao_automatica ?? false;

      const membroIds = memberships.map((m) => m.user_id);
      const etapasAtivas = ['lead', 'conversa_iniciada', 'reuniao_marcada', 'proposta'];
      if (membroIds.length > 0) {
        const { data: leadsAtivos } = await supabase
          .from('leads')
          .select('sdr_responsavel_id')
          .eq('doctor_id', doctorId)
          .in('status_atual', etapasAtivas)
          .in('sdr_responsavel_id', membroIds);
        membroIds.forEach((id) => (contagem[id] = 0));
        (leadsAtivos || []).forEach((l) => { if (l.sdr_responsavel_id) contagem[l.sdr_responsavel_id] = (contagem[l.sdr_responsavel_id] || 0) + 1; });
      }
    }

    const membros = memberships
      .filter((m) => m.users) // usuário pode ter sido removido de `users`; não deveria acontecer (FK), defensivo
      .map((m) => ({
        ...m.users,
        leads_ativos: contagem[m.user_id] ?? 0,
        role: m.role,
        status: m.status,
        units: (m.membership_units || []).map((mu) => mu.units).filter(Boolean),
      }));

    return res.json({ distribuicao_automatica, membros });
  }

  // --- legado (inalterado) ---
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id } = req.query;

  const targetDoctorId = doctor_id ?? scopedIds?.[0];
  if (!targetDoctorId) return res.status(400).json({ error: 'doctor_id é obrigatório' });

  if (scopedIds && !scopedIds.includes(targetDoctorId)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  // FASE 2.3: shadow-read — só registra divergência user_doctor_access x
  // memberships quando a flag está ligada. Não altera a resposta nem o banco.
  await shadowCompareTeam(req, targetDoctorId).catch(() => {});

  const { data: vinculos, error } = await supabase
    .from('user_doctor_access')
    .select('user_id, users(id, nome, email, ativo, criado_em)')
    .eq('doctor_id', targetDoctorId);

  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }

  const { data: doctorRow } = await supabase
    .from('doctors')
    .select('distribuicao_automatica')
    .eq('id', targetDoctorId)
    .single();

  const membroIds = vinculos.map((v) => v.user_id);
  const etapasAtivas = ['lead', 'conversa_iniciada', 'reuniao_marcada', 'proposta'];

  let contagem = {};
  if (membroIds.length > 0) {
    const { data: leadsAtivos } = await supabase
      .from('leads')
      .select('sdr_responsavel_id')
      .eq('doctor_id', targetDoctorId)
      .in('status_atual', etapasAtivas)
      .in('sdr_responsavel_id', membroIds);

    membroIds.forEach((id) => (contagem[id] = 0));
    (leadsAtivos || []).forEach((l) => {
      if (l.sdr_responsavel_id) contagem[l.sdr_responsavel_id] = (contagem[l.sdr_responsavel_id] || 0) + 1;
    });
  }

  const membros = vinculos.map((v) => ({ ...v.users, leads_ativos: contagem[v.user_id] ?? 0 }));

  res.json({
    distribuicao_automatica: doctorRow?.distribuicao_automatica ?? false,
    membros,
  });
});

// PATCH /team/distribuicao — liga/desliga a distribuição automática do médico
// (fora do escopo do cutover — continua por doctor_id, ver auditoria 23 §2)
router.patch('/distribuicao', requireTeamManager, async (req, res) => {
  const { doctor_id, ativo } = req.body;
  let targetDoctorId = doctor_id;
  if (membershipsOn(req)) {
    targetDoctorId = req.tenant.doctorId;
    if (!targetDoctorId) return res.status(400).json({ error: 'doctor_id é obrigatório' });
  } else {
    const scopedIds = await getScopedDoctorIds(req.user);
    if (!doctor_id) return res.status(400).json({ error: 'doctor_id é obrigatório' });
    if (scopedIds && !scopedIds.includes(doctor_id)) {
      return res.status(403).json({ error: 'Sem acesso a este médico' });
    }
  }

  const { error } = await supabase.from('doctors').update({ distribuicao_automatica: !!ativo }).eq('id', targetDoctorId);
  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  res.json({ ok: true, distribuicao_automatica: !!ativo });
});

// ===========================================================================
// POST /team — convida/adiciona um membro.
// Legado: cria closer vinculado a doctor_id. Sob a flag: cria membership com
// o papel pedido (validado pelo servidor) + unidades, via RPC transacional.
// Body NUNCA carrega organization_id/doctor_id/role do ator/user_id — só os
// dados do NOVO membro.
// ===========================================================================
router.post('/', teamMutationLimiter, requireTeamManager, async (req, res) => {
  if (membershipsOn(req)) {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
    const { nome, email, role, unit_ids } = parsed.data;
    const organizationId = req.tenant.organizationId;

    const { data: authUser, error: authError } = await supabase.auth.admin.inviteUserByEmail(email);
    if (authError) { req.log?.error({ err: authError }, 'Team invite failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }

    // users.role é travado em admin/doctor/closer (schema legado) — 'closer' é
    // o valor menos privilegiado para qualquer papel novo. Não concede, por si
    // só, nenhum acesso: sem linha em user_doctor_access, o legado não enxerga
    // este usuário em nada.
    const { error: userError } = await supabase.from('users').insert({ id: authUser.user.id, nome, email, role: 'closer' });
    if (userError) { req.log?.error({ err: userError }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }

    const { data, error: rpcError } = await supabase.rpc('team_member_add', {
      p_organization_id: organizationId,
      p_actor_user_id: req.user.id,
      p_target_user_id: authUser.user.id,
      p_role: role,
      p_unit_ids: unit_ids,
    });
    if (rpcError) {
      // A RPC negou (papel/unidade/conflito) — não deixa conta órfã pra trás
      // (a criação em Auth/users não é transacional com a RPC; melhor
      // esforço de limpeza, nunca bloqueia a resposta de erro por causa disso).
      await supabase.from('users').delete().eq('id', authUser.user.id).then(
        (r) => { if (r?.error) req.log?.error({ err: r.error }, 'team invite cleanup (users) failed'); },
        (err) => req.log?.error({ err }, 'team invite cleanup (users) failed')
      );
      await supabase.auth.admin.deleteUser(authUser.user.id).catch(
        (err) => req.log?.error({ err }, 'team invite cleanup (auth) failed')
      );
      return rpcErrorResponse(res, req, rpcError);
    }

    return res.status(201).json({ id: authUser.user.id, nome, email, role: data.role, status: data.status });
  }

  // --- legado (inalterado) ---
  const { doctor_id, nome, email } = req.body;
  const scopedIds = await getScopedDoctorIds(req.user);

  if (!doctor_id || !nome || !email) {
    return res.status(400).json({ error: 'doctor_id, nome e email são obrigatórios' });
  }
  if (scopedIds && !scopedIds.includes(doctor_id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const { data: authUser, error: authError } = await supabase.auth.admin.inviteUserByEmail(email);
  if (authError) {
    req.log?.error({ err: authError }, 'Team invite failed');
    return res.status(500).json({ error: 'internal_error', requestId: req.id });
  }

  const { error: userError } = await supabase.from('users').insert({
    id: authUser.user.id,
    nome,
    email,
    role: 'closer',
  });
  if (userError) {
    req.log?.error({ err: userError }, 'Database request failed');
    return res.status(500).json({ error: 'internal_error', requestId: req.id });
  }

  const { error: linkError } = await supabase
    .from('user_doctor_access')
    .insert({ user_id: authUser.user.id, doctor_id });
  if (linkError) {
    req.log?.error({ err: linkError }, 'Database request failed');
    return res.status(500).json({ error: 'internal_error', requestId: req.id });
  }

  res.status(201).json({ id: authUser.user.id, nome, email, role: 'closer' });
});

// ===========================================================================
// Rotas novas (só existem com a flag ligada — 404 caso contrário, nunca
// expõem superfície nova silenciosamente).
// ===========================================================================
router.patch('/:userId/role', teamMutationLimiter, requireTeamManager, async (req, res) => {
  if (!membershipsOn(req)) return res.status(404).json({ error: 'not_found' });
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const { data, error } = await supabase.rpc('team_member_change_role', {
    p_organization_id: req.tenant.organizationId,
    p_actor_user_id: req.user.id,
    p_target_user_id: req.params.userId,
    p_new_role: parsed.data.role,
  });
  if (error) return rpcErrorResponse(res, req, error);
  res.json({ ok: true, role: data.role, status: data.status });
});

router.patch('/:userId/status', teamMutationLimiter, requireTeamManager, async (req, res) => {
  if (!membershipsOn(req)) return res.status(404).json({ error: 'not_found' });
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const { data, error } = await supabase.rpc('team_member_set_status', {
    p_organization_id: req.tenant.organizationId,
    p_actor_user_id: req.user.id,
    p_target_user_id: req.params.userId,
    p_new_status: parsed.data.status,
  });
  if (error) return rpcErrorResponse(res, req, error);
  res.json({ ok: true, role: data.role, status: data.status });
});

router.patch('/:userId/units', teamMutationLimiter, requireTeamManager, async (req, res) => {
  if (!membershipsOn(req)) return res.status(404).json({ error: 'not_found' });
  const parsed = unitsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const { data, error } = await supabase.rpc('team_member_set_units', {
    p_organization_id: req.tenant.organizationId,
    p_actor_user_id: req.user.id,
    p_target_user_id: req.params.userId,
    p_unit_ids: parsed.data.unit_ids,
  });
  if (error) return rpcErrorResponse(res, req, error);
  res.json({ ok: true, unit_ids: data.unit_ids });
});

// DELETE /team/:userId?doctor_id= — remove o acesso do closer àquele médico
// (legado) OU remove a membership inteira (flag ligada).
router.delete('/:userId', teamMutationLimiter, requireTeamManager, async (req, res) => {
  if (membershipsOn(req)) {
    const { error } = await supabase.rpc('team_member_remove', {
      p_organization_id: req.tenant.organizationId,
      p_actor_user_id: req.user.id,
      p_target_user_id: req.params.userId,
    });
    if (error) return rpcErrorResponse(res, req, error);
    return res.status(204).send();
  }

  // --- legado (inalterado) ---
  const { userId } = req.params;
  const { doctor_id } = req.query;
  const scopedIds = await getScopedDoctorIds(req.user);

  if (scopedIds && !scopedIds.includes(doctor_id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const { error } = await supabase
    .from('user_doctor_access')
    .delete()
    .eq('user_id', userId)
    .eq('doctor_id', doctor_id);

  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  res.status(204).send();
});

export default router;
