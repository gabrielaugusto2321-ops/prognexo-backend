import { supabase } from '../lib/supabase.js';

// Valida o JWT do Supabase Auth enviado pelo frontend e carrega o usuário
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const { data: profile } = await supabase
    .from('users')
    .select('*')
    .eq('id', user.id)
    .single();

  if (!profile || !profile.ativo) {
    return res.status(403).json({ error: 'Usuário sem acesso' });
  }

  req.user = profile;
  next();
}

// Retorna os doctor_ids que o usuário logado pode enxergar.
// null = sem filtro (admin vê tudo).
export async function getScopedDoctorIds(user) {
  if (user.role === 'admin') return null;

  if (user.role === 'doctor') {
    const { data } = await supabase.from('doctors').select('id').eq('owner_user_id', user.id);
    return (data || []).map((d) => d.id);
  }

  // closer
  const { data } = await supabase
    .from('user_doctor_access')
    .select('doctor_id')
    .eq('user_id', user.id);

  return (data || []).map((d) => d.doctor_id);
}

// Retorna true se o usuário deve ver só a PRÓPRIA carteira de leads
// (papel closer), em vez de todos os leads do(s) médico(s) que ele acessa.
export function isScopedToOwnLeadsOnly(user) {
  return user.role === 'closer';
}
