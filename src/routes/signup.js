import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// POST /signup — rota PÚBLICA (sem login), usada pelos links de cadastro.
// Body: { nome, clinica, email, password, plano }
// `plano` só pode ser 'gratuito' ou 'pago' — vem fixo de cada página de
// cadastro (mentoria vs cliente), não é escolha livre do usuário.
router.post('/', async (req, res) => {
  const { nome, clinica, email, password, plano } = req.body;

  if (!nome || !email || !password || !['gratuito', 'pago'].includes(plano)) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Senha precisa ter pelo menos 6 caracteres' });
  }

  // 1. Cria a conta de login (Supabase Auth)
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (authError) {
    return res.status(400).json({ error: authError.message });
  }

  // 2. Cria o perfil na tabela users, como 'doctor'
  const { error: userError } = await supabase.from('users').insert({
    id: authUser.user.id,
    nome,
    email,
    role: 'doctor',
  });

  if (userError) {
    return res.status(500).json({ error: userError.message });
  }

  // 3. Cria o registro do médico (tenant), vinculado a esse usuário
  const { error: doctorError } = await supabase.from('doctors').insert({
    owner_user_id: authUser.user.id,
    nome: clinica || nome,
    status: 'ativo',
    plano,
  });

  if (doctorError) {
    return res.status(500).json({ error: doctorError.message });
  }

  res.status(201).json({ ok: true });
});

export default router;
