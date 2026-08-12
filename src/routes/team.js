import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

function requireDoctorOrAdmin(req, res, next) {
  if (req.user.role !== 'doctor' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Só o médico ou admin pode gerenciar a equipe' });
  }
  next();
}

// GET /team?doctor_id= — lista os closers vinculados ao médico, com quantos
// leads ativos cada um tem no momento, e se a distribuição automática está ligada
router.get('/', requireDoctorOrAdmin, async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id } = req.query;

  const targetDoctorId = doctor_id ?? scopedIds?.[0];
  if (!targetDoctorId) return res.status(400).json({ error: 'doctor_id é obrigatório' });

  if (scopedIds && !scopedIds.includes(targetDoctorId)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const { data: vinculos, error } = await supabase
    .from('user_doctor_access')
    .select('user_id, users(id, nome, email, ativo, criado_em)')
    .eq('doctor_id', targetDoctorId);

  if (error) return res.status(500).json({ error: error.message });

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
router.patch('/distribuicao', requireDoctorOrAdmin, async (req, res) => {
  const { doctor_id, ativo } = req.body;
  const scopedIds = await getScopedDoctorIds(req.user);

  if (!doctor_id) return res.status(400).json({ error: 'doctor_id é obrigatório' });
  if (scopedIds && !scopedIds.includes(doctor_id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const { error } = await supabase.from('doctors').update({ distribuicao_automatica: !!ativo }).eq('id', doctor_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, distribuicao_automatica: !!ativo });
});

// POST /team — convida um novo closer pro médico
// Body: { doctor_id, nome, email }
// Cria o usuário no Supabase Auth (envia e-mail de convite/senha), o registro
// em `users` com role='closer', e o vínculo em `user_doctor_access`.
router.post('/', requireDoctorOrAdmin, async (req, res) => {
  const { doctor_id, nome, email } = req.body;
  const scopedIds = await getScopedDoctorIds(req.user);

  if (!doctor_id || !nome || !email) {
    return res.status(400).json({ error: 'doctor_id, nome e email são obrigatórios' });
  }
  if (scopedIds && !scopedIds.includes(doctor_id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  // Cria o usuário no Supabase Auth e dispara e-mail de convite (define senha no primeiro acesso)
  const { data: authUser, error: authError } = await supabase.auth.admin.inviteUserByEmail(email);
  if (authError) return res.status(500).json({ error: authError.message });

  const { error: userError } = await supabase.from('users').insert({
    id: authUser.user.id,
    nome,
    email,
    role: 'closer',
  });
  if (userError) return res.status(500).json({ error: userError.message });

  const { error: linkError } = await supabase
    .from('user_doctor_access')
    .insert({ user_id: authUser.user.id, doctor_id });
  if (linkError) return res.status(500).json({ error: linkError.message });

  res.status(201).json({ id: authUser.user.id, nome, email, role: 'closer' });
});

// DELETE /team/:userId?doctor_id= — remove o acesso do closer àquele médico
// (não apaga a conta, só o vínculo — o closer pode estar ligado a outro médico)
router.delete('/:userId', requireDoctorOrAdmin, async (req, res) => {
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

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

export default router;
