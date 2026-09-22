import { supabase } from '../lib/supabase.js';

// /admin/doctors inteiro é isento: TODA sub-rota já exige platform_admin via
// checagem própria (src/routes/adminDoctors.js) — bloquear aqui impediria o
// próprio admin de reativar/pausar contas, sem abrir nenhum acesso extra
// (quem não é platform_admin já leva 403 daquela checagem, com ou sem gate).
const COURTESY_GATE_EXEMPT_BASE_URLS = new Set(['/admin/doctors']);

// Isenção de precisão cirúrgica: SÓ GET /tenant/context — precisa ficar
// acessível pra listar organizações e trocar pra uma válida, mesmo que
// OUTRA organização do usuário esteja vencida/pausada. Qualquer outra rota
// sob /tenant (ex.: GET /tenant/shadow-metrics) continua passando pelo gate
// normalmente — método+baseUrl+path exatos, nunca um prefixo genérico.
const COURTESY_GATE_EXEMPT_ROUTES = [
  { method: 'GET', baseUrl: '/tenant', path: '/context' },
];

// Uma única RPC decide bloqueio por cortesia vencida OU conta pausada.
// Nunca bloqueia em caso de ambiguidade (múltiplas organizações sem seleção
// explícita) — ver comentário da função em migrations/0021.
async function courtesyGateReason(user, req) {
  if (COURTESY_GATE_EXEMPT_BASE_URLS.has(req.baseUrl)) return null;
  const isExemptRoute = COURTESY_GATE_EXEMPT_ROUTES.some(
    (r) => r.method === req.method && r.baseUrl === req.baseUrl && r.path === req.path,
  );
  if (isExemptRoute) return null;

  const requestedOrg = req.get('X-Organization-Id') || (typeof req.query.organization_id === 'string' ? req.query.organization_id : null);
  const { data, error } = await supabase.rpc('doctor_access_gate', {
    p_user_id: user.id,
    p_organization_id: requestedOrg || null,
  });
  if (error) throw error; // fail closed: caller converte falha de lookup em 500
  const row = Array.isArray(data) ? data[0] : data;
  return row?.blocked ? row.reason : null;
}

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

  try {
    const blockReason = await courtesyGateReason(profile, req);
    if (blockReason) {
      return res.status(403).json({ error: blockReason });
    }
    req.user = profile;
    next();
  } catch (err) {
    req.log?.error({ err }, 'courtesy/pause gate lookup failed');
    return res.status(500).json({ error: 'internal_error', requestId: req.id });
  }
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
