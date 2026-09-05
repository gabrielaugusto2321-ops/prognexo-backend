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

  it('entrega de convite exige outbox habilitado', () => {
    expect(() => validateEnv({ ...base, TEAM_INVITE_EMAIL_DELIVERY_ENABLED: 'true' }))
      .toThrow(/TEAM_INVITE_OUTBOX_ENABLED/);
  });

  it('outbox exige keyring/active key mesmo com TOKEN_ENCRYPTION_ENABLED=false', () => {
    expect(() => validateEnv({ ...base, TEAM_INVITE_OUTBOX_ENABLED: 'true' }))
      .toThrow(/TOKEN_ENCRYPTION_KEYRING/);
  });

  it('dupla flag exige RESEND_API_KEY', () => {
    const key = Buffer.alloc(32, 1).toString('base64');
    expect(() => validateEnv({ ...base, TEAM_INVITE_OUTBOX_ENABLED: 'true', TEAM_INVITE_EMAIL_DELIVERY_ENABLED: 'true', TOKEN_ENCRYPTION_KEYRING: JSON.stringify({ v1: key }), TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1' }))
      .toThrow(/RESEND_API_KEY/);
  });

  it('outbox configurado funciona sem ligar a criptografia legada', () => {
    const key = Buffer.alloc(32, 2).toString('base64');
    expect(() => validateEnv({ ...base, TEAM_INVITE_OUTBOX_ENABLED: 'true', TOKEN_ENCRYPTION_ENABLED: 'false', TOKEN_ENCRYPTION_KEYRING: JSON.stringify({ v1: key }), TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1' })).not.toThrow();
  });

  // FASE 2.8 — fila de jobs persistente + quotas
  const jobKeyring = () => {
    const key = Buffer.alloc(32, 4).toString('base64');
    return { TOKEN_ENCRYPTION_KEYRING: JSON.stringify({ v1: key }), TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1', JOB_RUNNER_SECRET: 'job-runner-secret-value' };
  };

  it('CAMPAIGN_JOB_QUEUE_ENABLED exige PERSISTENT_JOB_QUEUE_ENABLED', () => {
    expect(() => validateEnv({ ...base, CAMPAIGN_JOB_QUEUE_ENABLED: 'true', USAGE_QUOTAS_ENABLED: 'true', ...jobKeyring() }))
      .toThrow(/CAMPAIGN_JOB_QUEUE_ENABLED=true exige PERSISTENT_JOB_QUEUE_ENABLED/);
  });

  it('PERSISTENT_JOB_QUEUE_ENABLED exige keyring/active key (payload sensível é cifrado)', () => {
    expect(() => validateEnv({ ...base, PERSISTENT_JOB_QUEUE_ENABLED: 'true' }))
      .toThrow(/TOKEN_ENCRYPTION_KEYRING|TOKEN_ENCRYPTION_ACTIVE_KEY/);
  });

  it('PERSISTENT_JOB_QUEUE_ENABLED exige JOB_RUNNER_SECRET (worker só autentica por header)', () => {
    const key = Buffer.alloc(32, 4).toString('base64');
    expect(() => validateEnv({ ...base, PERSISTENT_JOB_QUEUE_ENABLED: 'true', TOKEN_ENCRYPTION_KEYRING: JSON.stringify({ v1: key }), TOKEN_ENCRYPTION_ACTIVE_KEY: 'v1' }))
      .toThrow(/JOB_RUNNER_SECRET/);
  });

  it('em produção, CAMPAIGN_JOB_QUEUE_ENABLED exige USAGE_QUOTAS_ENABLED', () => {
    expect(() => validateEnv({ ...base, PERSISTENT_JOB_QUEUE_ENABLED: 'true', CAMPAIGN_JOB_QUEUE_ENABLED: 'true', USAGE_QUOTAS_ENABLED: 'false', ...jobKeyring() }))
      .toThrow(/exige USAGE_QUOTAS_ENABLED=true em produção/);
  });

  it('fila de jobs configurada corretamente em produção → OK, sem ligar a criptografia legada', () => {
    expect(() => validateEnv({ ...base, PERSISTENT_JOB_QUEUE_ENABLED: 'true', USAGE_QUOTAS_ENABLED: 'true', CAMPAIGN_JOB_QUEUE_ENABLED: 'true', TOKEN_ENCRYPTION_ENABLED: 'false', ...jobKeyring() })).not.toThrow();
  });
});
