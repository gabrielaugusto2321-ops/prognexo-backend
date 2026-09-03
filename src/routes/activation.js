import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { activationLimiter } from '../middleware/rateLimits.js';

const router = Router();

// POST /activation/complete
//
// Ativa a conta DEPOIS que o usuário confirmou o e-mail e definiu a senha pelo
// link de convite da Supabase.
//
// Segurança:
//  - NÃO passa por `requireAuth` (esse middleware bloqueia usuários pendentes).
//  - A identidade vem SÓ do JWT (Authorization: Bearer). O corpo é ignorado por
//    completo — não é possível escolher qual conta ativar via id/email/role.
//  - Exige `email_confirmed_at` preenchido no usuário do Supabase Auth.
//  - Idempotente: chamar de novo numa conta já ativa devolve o mesmo 200.
//  - Rate-limit + resposta uniforme (sem enumeração).
router.post('/complete', activationLimiter, async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const token = authHeader.slice('Bearer '.length);

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // O e-mail precisa estar confirmado (o link de convite faz isso).
  if (!user.email_confirmed_at) {
    return res.status(403).json({ error: 'email_not_confirmed' });
  }

  try {
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('id, ativo, status')
      .eq('id', user.id)
      .maybeSingle();
    if (profileError) throw profileError;

    if (!profile) {
      // Não existe perfil para esse usuário — nada a ativar. Resposta neutra.
      return res.status(404).json({ error: 'not_found' });
    }

    // Já ativo: idempotente.
    if (profile.ativo === true && profile.status === 'active') {
      return res.status(200).json({ ok: true, status: 'active' });
    }

    // Só ativamos contas que estão realmente pendentes (nunca 'suspended').
    if (profile.status !== 'pending') {
      return res.status(409).json({ error: 'not_activatable' });
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({ ativo: true, status: 'active' })
      .eq('id', user.id)
      .eq('status', 'pending'); // guarda contra corrida: só muda se ainda pendente
    if (updateError) throw updateError;

    // Ativa também a clínica do dono (não bloqueia a ativação do usuário se falhar).
    const doctorUpdate = await supabase.from('doctors').update({ status: 'ativo' }).eq('owner_user_id', user.id);
    if (doctorUpdate.error) req.log?.error({ err: doctorUpdate.error }, 'Activation: doctor status update failed');

    return res.status(200).json({ ok: true, status: 'active' });
  } catch (error) {
    logger.error({ err: error }, 'Activation failed');
    return res.status(500).json({ error: 'internal_error', requestId: req.id });
  }
});

export default router;
