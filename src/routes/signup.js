import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { verifyCaptcha } from '../lib/captcha.js';
import { logger } from '../lib/logger.js';
import { signupHourlyLimiter, signupDailyLimiter } from '../middleware/rateLimits.js';

const router = Router();

// O cliente só pode enviar dados de identificação. `plano`, `role`, `ativo`,
// `status` e qualquer privilégio são SEMPRE definidos pelo servidor.
// Não há campo de senha: o usuário define a senha pelo link seguro que a
// Supabase envia por e-mail (fluxo de convite) — ver POST /activation/complete.
const schema = z
  .object({
    nome: z.string().trim().min(2).max(120),
    clinica: z.string().trim().max(120).optional(),
    email: z
      .string()
      .email()
      .transform((v) => v.toLowerCase()),
    captchaToken: z.string().optional(),
  })
  .strip();

// POST /signup — rota PÚBLICA. Sempre responde 202 (anti-enumeração):
// nunca revela se o e-mail já tem conta.
router.post('/', signupHourlyLimiter, signupDailyLimiter, async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_signup_data' });

  const { nome, clinica, email, captchaToken } = parsed.data;

  if (!(await verifyCaptcha(captchaToken, req.ip))) {
    return res.status(403).json({ error: 'captcha_required' });
  }

  let authUserId;
  try {
    // E-mail já cadastrado: responde igual a um cadastro novo (sem vazar isso).
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (existing) return res.status(202).json({ ok: true });

    // Envia o convite (define senha + confirma e-mail no mesmo link).
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, { data: { nome } });
    if (error || !data?.user) {
      logger.info({ err: error }, 'Signup invite rejected');
      return res.status(202).json({ ok: true });
    }
    authUserId = data.user.id;

    // Conta nasce sempre: doctor, plano gratuito, pendente e inativa.
    const userResult = await supabase.from('users').insert({
      id: authUserId,
      nome,
      email,
      role: 'doctor',
      ativo: false,
      status: 'pending',
    });
    if (userResult.error) throw userResult.error;

    const doctorResult = await supabase.from('doctors').insert({
      owner_user_id: authUserId,
      nome: clinica || nome,
      status: 'pendente',
      plano: 'gratuito',
    });
    if (doctorResult.error) throw doctorResult.error;
  } catch (error) {
    logger.error({ err: error, authUserId }, 'Signup provisioning failed');
    // Compensação: desfaz o auth user se o provisionamento parou no meio.
    if (authUserId) {
      try {
        await supabase.auth.admin.deleteUser(authUserId);
      } catch (rollbackError) {
        logger.error({ err: rollbackError, authUserId }, 'Signup compensation failed');
      }
    }
  }

  return res.status(202).json({ ok: true });
});

export default router;
