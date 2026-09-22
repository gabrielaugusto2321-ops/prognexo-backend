import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { isPlatformAdminUser } from '../lib/tenantContext.js';
import { sendCourtesyInviteEmail } from '../lib/emailAdapter.js';
import { canonicalAuthRedirectTo } from '../lib/authRedirect.js';

const router = Router();
router.use(requireAuth);
router.use(async (req, res, next) => {
  if (!(await isPlatformAdminUser(req.user))) return res.status(403).json({ error: 'forbidden' });
  next();
});

const createSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  clinica: z.string().trim().min(2).max(120),
  email: z.string().email().transform((value) => value.toLowerCase()),
  dias_cortesia: z.number().int().min(1).max(365).default(60),
}).strict();

async function findDoctor(id) {
  return supabase.from('doctors').select('id, owner_user_id, status').eq('id', id).maybeSingle();
}

router.get('/', async (req, res) => {
  const { data: doctors, error } = await supabase
    .from('doctors')
    .select('id, nome, owner_user_id, status, courtesy_expires_at, criado_em')
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ error: 'internal_error', requestId: req.id });

  const ownerIds = [...new Set((doctors || []).map((doctor) => doctor.owner_user_id).filter(Boolean))];
  const doctorIds = (doctors || []).map((doctor) => doctor.id);
  const [{ data: owners }, { data: maps }] = await Promise.all([
    ownerIds.length ? supabase.from('users').select('id, email').in('id', ownerIds) : { data: [] },
    doctorIds.length ? supabase.from('organization_doctor_map').select('doctor_id, organization_id').in('doctor_id', doctorIds) : { data: [] },
  ]);
  const organizationIds = [...new Set((maps || []).map((map) => map.organization_id))];
  const { data: organizations } = organizationIds.length
    ? await supabase.from('organizations').select('id, name').in('id', organizationIds)
    : { data: [] };
  const ownerById = new Map((owners || []).map((owner) => [owner.id, owner.email]));
  const mapByDoctor = new Map((maps || []).map((map) => [map.doctor_id, map.organization_id]));
  const orgById = new Map((organizations || []).map((org) => [org.id, org.name]));
  return res.json((doctors || []).map((doctor) => ({
    id: doctor.id,
    nome: orgById.get(mapByDoctor.get(doctor.id)) || doctor.nome,
    owner_email: ownerById.get(doctor.owner_user_id) || null,
    status: doctor.status,
    courtesy_expires_at: doctor.courtesy_expires_at,
    created_at: doctor.criado_em,
  })));
});

router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  const { nome, clinica, email, dias_cortesia } = parsed.data;
  const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (existing) return res.status(409).json({ error: 'email_already_exists' });

  let authUserId;
  try {
    const invitation = await supabase.auth.admin.inviteUserByEmail(email, { data: { nome }, redirectTo: canonicalAuthRedirectTo() });
    if (invitation.error || !invitation.data?.user) return res.status(502).json({ error: 'invite_failed' });
    authUserId = invitation.data.user.id;
    const provision = await supabase.rpc('signup_provision_tenant', {
      p_auth_user_id: authUserId, p_nome: nome, p_email: email, p_clinica_nome: clinica,
    });
    if (provision.error || !provision.data?.[0]?.doctor_id) throw provision.error || new Error('invalid_provision_result');
    const doctorId = provision.data[0].doctor_id;
    const courtesyExpiresAt = new Date(Date.now() + dias_cortesia * 86_400_000).toISOString();
    const updated = await supabase.from('doctors').update({ courtesy_expires_at: courtesyExpiresAt }).eq('id', doctorId).select('id, status, courtesy_expires_at').single();
    if (updated.error) throw updated.error;
    return res.status(201).json(updated.data);
  } catch (error) {
    req.log?.error({ err: error, authUserId }, 'Courtesy doctor provisioning failed');
    if (authUserId) await supabase.auth.admin.deleteUser(authUserId).catch(() => {});
    return res.status(500).json({ error: 'provisioning_failed', requestId: req.id });
  }
});

router.post('/:id/resend-invite', async (req, res) => {
  const { data: doctor, error } = await findDoctor(req.params.id);
  if (error) return res.status(500).json({ error: 'internal_error', requestId: req.id });
  if (!doctor) return res.status(404).json({ error: 'not_found' });
  const { data: owner } = await supabase.from('users').select('email, ativo, status').eq('id', doctor.owner_user_id).maybeSingle();
  if (!owner) return res.status(409).json({ error: 'not_invitable' });
  // Motivo explícito por caso: conta já ativa é o caso que mais importa
  // distinguir (o admin precisa saber que não há nada pendente ali), o
  // resto (pausado/encerrado/estado de convite inconsistente) cai em
  // not_invitable — nunca reenvia pra uma conta que já tem senha definida.
  if (owner.ativo === true) return res.status(409).json({ error: 'account_already_active' });
  if (doctor.status !== 'prospect' || owner.status !== 'pending') {
    return res.status(409).json({ error: 'not_invitable' });
  }
  // resend({type:'signup'}) e documentado pro fluxo signUp() client-side, nao
  // pro convite admin (inviteUserByEmail = acao 'invite' no GoTrue, rastreada
  // separada de 'signup' — nao ha garantia de que funcione aqui). O mecanismo
  // correto e documentado pra regenerar um convite existente e
  // generateLink({type:'invite'}) — NUNCA cria um segundo usuario/tenant pro
  // mesmo e-mail (reaproveita o auth.users ja criado), mas nao envia e-mail
  // sozinho, entao enviamos nos mesmos via Resend (sendCourtesyInviteEmail).
  let redirectTo;
  try {
    redirectTo = canonicalAuthRedirectTo();
  } catch (err) {
    req.log?.error({ err }, 'Courtesy invite redirect misconfigured');
    return res.status(500).json({ error: 'internal_error', requestId: req.id });
  }
  const link = await supabase.auth.admin.generateLink({ type: 'invite', email: owner.email, options: { redirectTo } });
  if (link.error || !link.data?.properties?.action_link) {
    req.log?.error({ err: link.error }, 'Courtesy invite link generation failed');
    return res.status(502).json({ error: 'invite_resend_failed' });
  }
  try {
    await sendCourtesyInviteEmail({ to: owner.email, actionLink: link.data.properties.action_link, clinicName: doctor.nome });
  } catch (err) {
    req.log?.error({ err }, 'Courtesy invite email delivery failed');
    return res.status(502).json({ error: 'invite_resend_failed' });
  }
  return res.json({ ok: true });
});

router.patch('/:id/pause', async (req, res) => {
  const { data: doctor, error } = await findDoctor(req.params.id);
  if (error) return res.status(500).json({ error: 'internal_error', requestId: req.id });
  if (!doctor) return res.status(404).json({ error: 'not_found' });
  const updated = await supabase.from('doctors').update({ status: 'pausado' }).eq('id', doctor.id).select('id, status, courtesy_expires_at').single();
  if (updated.error) return res.status(500).json({ error: 'internal_error', requestId: req.id });
  return res.json(updated.data);
});

router.patch('/:id/reactivate', async (req, res) => {
  const { data: doctor, error } = await findDoctor(req.params.id);
  if (error) return res.status(500).json({ error: 'internal_error', requestId: req.id });
  if (!doctor) return res.status(404).json({ error: 'not_found' });
  // Reativacao altera apenas o estado operacional; estender cortesia exige uma
  // decisao administrativa explicita e nao deve acontecer implicitamente.
  const updated = await supabase.from('doctors').update({ status: 'ativo' }).eq('id', doctor.id).select('id, status, courtesy_expires_at').single();
  if (updated.error) return res.status(500).json({ error: 'internal_error', requestId: req.id });
  return res.json(updated.data);
});

export default router;
