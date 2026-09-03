import { z } from 'zod';

// Validação das variáveis de ambiente. Em produção, faltar uma variável
// obrigatória DERRUBA o boot (fail-fast) — nunca sobe degradado em silêncio.
// Nenhum valor é logado.

const optionalSecret = z.string().min(1).optional();
const bool = z.enum(['true', 'false']);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Topologia — usado pela checagem do store de rate-limit.
  APP_INSTANCE_COUNT: z.string().regex(/^\d+$/).optional(),

  // Supabase
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,

  // IA / integrações
  ANTHROPIC_API_KEY: optionalSecret,
  META_APP_SECRET: optionalSecret,
  META_SYSTEM_USER_TOKEN: optionalSecret,
  WHATSAPP_VERIFY_TOKEN: optionalSecret,
  VOYAGE_API_KEY: optionalSecret,
  CRON_SECRET: optionalSecret,

  // Frontend / CORS
  FRONTEND_URL: z.string().url().optional(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // CAPTCHA
  CAPTCHA_ENABLED: bool.default('false'),
  CAPTCHA_PROVIDER: z.string().default('turnstile'),
  CAPTCHA_SECRET: optionalSecret,

  // Webhooks — todos os gates começam FECHADOS para produção.
  WHATSAPP_WEBHOOK_SIGNATURE_ENFORCED: bool.default('true'),
  PAYMENT_WEBHOOKS_ENABLED: bool.default('false'), // master switch dos webhooks de pagamento
  PAYMENT_WEBHOOKS_ENFORCE_SIGNATURE: bool.default('true'),
  TICTO_WEBHOOK_ENABLED: bool.default('false'), // Ticto não tem assinatura criptográfica

  // Checkout legado com cartão — desligado por padrão em produção.
  LEGACY_CARD_CHECKOUT_ENABLED: bool.default('false'),

  // Segredos de webhook de pagamento
  PAGARME_WEBHOOK_SECRET: optionalSecret,
  KIWIFY_WEBHOOK_SECRET: optionalSecret,
  HOTMART_HOTTOK: optionalSecret,
  TICTO_TOKEN: optionalSecret,

  // Google
  GOOGLE_CLIENT_ID: optionalSecret,
  GOOGLE_CLIENT_SECRET: optionalSecret,
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
});

export function validateEnv(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    const required = [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'ANTHROPIC_API_KEY',
      'META_APP_SECRET',
      'META_SYSTEM_USER_TOKEN',
      'WHATSAPP_VERIFY_TOKEN',
      'VOYAGE_API_KEY',
      'CRON_SECRET',
      'FRONTEND_URL',
      'CORS_ALLOWED_ORIGINS',
    ];
    const missing = required.filter((key) => !env[key]);

    if (env.CAPTCHA_ENABLED !== 'true' || !env.CAPTCHA_SECRET) missing.push('CAPTCHA_ENABLED/CAPTCHA_SECRET');

    // Só exige os segredos de pagamento se os webhooks de pagamento estiverem ligados.
    if (env.PAYMENT_WEBHOOKS_ENABLED === 'true' && env.PAYMENT_WEBHOOKS_ENFORCE_SIGNATURE === 'true') {
      for (const key of ['PAGARME_WEBHOOK_SECRET', 'KIWIFY_WEBHOOK_SECRET', 'HOTMART_HOTTOK']) {
        if (!env[key]) missing.push(key);
      }
    }

    if (missing.length) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  }

  return env;
}

export const env = validateEnv();
