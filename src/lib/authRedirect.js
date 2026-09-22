import { env } from '../config/env.js';

// Único ponto que decide pra onde um link de autenticação (convite, reenvio)
// deve mandar a pessoa de volta. NUNCA aceita URL vinda do cliente — só
// env.FRONTEND_URL, a mesma variável que já governa CORS_ALLOWED_ORIGINS e
// os links de team invitations. Existe pra nenhuma rota depender da Site URL
// configurada no painel do Supabase, que pode ficar desatualizada (foi
// exatamente isso que quebrou o primeiro onboarding real: o link caiu no
// domínio antigo *.vercel.app, que nem está na allowlist de CORS).
//
// Em produção, FRONTEND_URL ausente ou não-https é um erro de configuração
// grave o bastante pra falhar explicitamente (500) em vez de mandar alguém
// silenciosamente pra localhost ou pra um domínio errado.
export function canonicalAuthRedirectTo() {
  const raw = env.FRONTEND_URL;
  if (!raw) {
    if (env.APP_ENV === 'production') {
      throw Object.assign(new Error('FRONTEND_URL ausente em produção: link de autenticação recusado'), {
        code: 'frontend_url_missing',
      });
    }
    return 'http://localhost:5173/';
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw Object.assign(new Error(`FRONTEND_URL inválida: ${raw}`), { code: 'frontend_url_invalid' });
  }
  if (env.APP_ENV === 'production' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error(`FRONTEND_URL precisa ser https em produção: ${raw}`), {
      code: 'frontend_url_invalid',
    });
  }
  return `${parsed.origin}/`;
}
