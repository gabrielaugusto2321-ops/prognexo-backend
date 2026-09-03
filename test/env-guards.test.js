import { describe, it, expect } from 'vitest';
import { validateEnv } from '../src/config/env.js';

// validateEnv é puro (recebe a fonte). Testamos as combinações perigosas sem
// tocar process.env real.

const base = {
  NODE_ENV: 'production',
  APP_ENV: 'production',
  SUPABASE_URL: 'https://prod-abc.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'dummy',
  ANTHROPIC_API_KEY: 'dummy',
  META_APP_SECRET: 'dummy',
  META_SYSTEM_USER_TOKEN: 'dummy',
  WHATSAPP_VERIFY_TOKEN: 'dummy',
  VOYAGE_API_KEY: 'dummy',
  CRON_SECRET: 'dummy',
  FRONTEND_URL: 'https://app.prod.example',
  CORS_ALLOWED_ORIGINS: 'https://app.prod.example',
  CAPTCHA_ENABLED: 'true',
  CAPTCHA_SECRET: 'dummy',
  PRODUCTION_HOSTS: 'prod-abc.supabase.co,app.prod.example',
};

describe('env — combinações perigosas derrubam o boot', () => {
  it('produção completa e coerente → OK', () => {
    expect(() => validateEnv(base)).not.toThrow();
  });

  it('development apontando para SUPABASE de produção → erro', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'development', APP_ENV: 'development' })
    ).toThrow(/Dangerous environment/i);
  });

  it('test com SUPABASE_SERVICE_ROLE_KEY que parece JWT real → erro', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'test',
        APP_ENV: 'test',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOi.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcDEF-_123',
      })
    ).toThrow(/JWT real/i);
  });

  it('staging usando GOOGLE_REDIRECT_URI de host de produção → erro', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        SUPABASE_URL: 'https://staging.supabase.co',
        FRONTEND_URL: 'https://staging.example',
        CORS_ALLOWED_ORIGINS: 'https://staging.example',
        GOOGLE_REDIRECT_URI: 'https://app.prod.example/auth/google/callback',
        PRODUCTION_HOSTS: 'app.prod.example',
      })
    ).toThrow(/Dangerous environment/i);
  });

  it('staging exige as variáveis obrigatórias (como produção)', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'production', APP_ENV: 'staging', PRODUCTION_HOSTS: '' })
    ).toThrow(/Missing required environment variables \(APP_ENV=staging\)/);
  });

  it('development sem PRODUCTION_HOSTS não trava (sem lista, nada é "produção")', () => {
    expect(() => validateEnv({ NODE_ENV: 'development', APP_ENV: 'development', SUPABASE_URL: 'https://x.supabase.co' })).not.toThrow();
  });
});
