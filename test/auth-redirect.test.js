import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = { APP_ENV: 'test', FRONTEND_URL: undefined };
vi.mock('../src/config/env.js', () => ({ env: envState }));

const { canonicalAuthRedirectTo } = await import('../src/lib/authRedirect.js');

beforeEach(() => {
  envState.APP_ENV = 'test';
  envState.FRONTEND_URL = undefined;
});

describe('canonicalAuthRedirectTo', () => {
  it('deriva o destino canônico de env.FRONTEND_URL, sem barra dupla', () => {
    envState.FRONTEND_URL = 'https://app.prognexo.com.br';
    expect(canonicalAuthRedirectTo()).toBe('https://app.prognexo.com.br/');
  });

  it('ignora path/query/hash de FRONTEND_URL — usa só a origin', () => {
    envState.FRONTEND_URL = 'https://app.prognexo.com.br/algum/path?x=1#y';
    expect(canonicalAuthRedirectTo()).toBe('https://app.prognexo.com.br/');
  });

  it('nunca resolve para o domínio antigo, mesmo que ele apareça em outro lugar do ambiente', () => {
    envState.FRONTEND_URL = 'https://app.prognexo.com.br';
    const result = canonicalAuthRedirectTo();
    expect(result).not.toContain('vercel.app');
    expect(result).toBe('https://app.prognexo.com.br/');
  });

  it('fora de produção, cai em localhost quando FRONTEND_URL não está setada', () => {
    envState.APP_ENV = 'test';
    envState.FRONTEND_URL = undefined;
    expect(canonicalAuthRedirectTo()).toBe('http://localhost:5173/');
  });

  it('em produção, FRONTEND_URL ausente falha explicitamente (nunca cai pra localhost/Site URL)', () => {
    envState.APP_ENV = 'production';
    envState.FRONTEND_URL = undefined;
    expect(() => canonicalAuthRedirectTo()).toThrow(/FRONTEND_URL ausente/);
  });

  it('em produção, FRONTEND_URL não-https falha explicitamente', () => {
    envState.APP_ENV = 'production';
    envState.FRONTEND_URL = 'http://app.prognexo.com.br';
    expect(() => canonicalAuthRedirectTo()).toThrow(/precisa ser https/);
  });

  it('em produção, FRONTEND_URL malformada falha explicitamente', () => {
    envState.APP_ENV = 'production';
    envState.FRONTEND_URL = 'não-é-uma-url';
    expect(() => canonicalAuthRedirectTo()).toThrow(/inválida/);
  });

  it('em produção, FRONTEND_URL https válida funciona normalmente', () => {
    envState.APP_ENV = 'production';
    envState.FRONTEND_URL = 'https://app.prognexo.com.br';
    expect(canonicalAuthRedirectTo()).toBe('https://app.prognexo.com.br/');
  });
});
