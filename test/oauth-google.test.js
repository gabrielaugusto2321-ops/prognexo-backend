import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
process.env.FRONTEND_URL = 'https://app.test';

let db;
const trocarCodigoPorTokens = vi.fn(async () => ({
  refresh_token: 'g-refresh',
  access_token: 'g-access',
  expiry_date: Date.now() + 3600_000,
}));

vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));
vi.mock('../src/lib/googleCalendar.js', () => ({
  buildAuthUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
  trocarCodigoPorTokens,
  estaConectado: vi.fn(async () => false),
}));

const { app } = await import('../src/server.js');
const { createOAuthState, consumeOAuthState, _resetOAuthStateStore, _expireOAuthState } = await import(
  '../src/lib/oauthState.js'
);

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

beforeEach(() => {
  _resetOAuthStateStore();
  trocarCodigoPorTokens.mockClear();
  db = makeDb({
    users: [
      { id: USER_A, role: 'doctor', ativo: true },
      { id: USER_B, role: 'doctor', ativo: true },
    ],
    google_tokens: [],
  });
  db.setAuthUser('tokA', { id: USER_A });
});

function stateFor(userId, role = 'doctor', flow = 'google_calendar') {
  return createOAuthState({ userId, role, flow });
}

describe('OAuth Google — state seguro (R06)', () => {
  it('/connect emite um state opaco (sem info) e o guarda no servidor', async () => {
    const res = await request(app).get('/auth/google/connect').set({ Authorization: 'Bearer tokA' });
    expect(res.status).toBe(200);
    const state = new URL(res.body.url).searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/); // base64url, alta entropia
    expect(state).not.toContain(USER_A); // nenhuma info sensível
    // consumível uma vez
    expect(consumeOAuthState(state, 'google_calendar')?.userId).toBe(USER_A);
  });

  it('state VÁLIDO: grava tokens para o usuário do state e redireciona "conectado"', async () => {
    const state = stateFor(USER_A);
    const res = await request(app).get(`/auth/google/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://app.test/#/agenda?google=conectado');
    const row = db.tables.google_tokens.find((r) => r.user_id === USER_A);
    expect(row.refresh_token).toBe('g-refresh');
  });

  it('state ALTERADO: rejeita (state_invalido), não troca código', async () => {
    const state = stateFor(USER_A);
    const res = await request(app).get(`/auth/google/callback?code=abc&state=${state}X`);
    expect(res.headers.location).toContain('google=state_invalido');
    expect(trocarCodigoPorTokens).not.toHaveBeenCalled();
    expect(db.tables.google_tokens).toHaveLength(0);
  });

  it('state AUSENTE: rejeita', async () => {
    const res = await request(app).get('/auth/google/callback?code=abc');
    expect(res.headers.location).toContain('google=state_invalido');
    expect(trocarCodigoPorTokens).not.toHaveBeenCalled();
  });

  it('state EXPIRADO: rejeita', async () => {
    const state = stateFor(USER_A);
    _expireOAuthState(state);
    const res = await request(app).get(`/auth/google/callback?code=abc&state=${state}`);
    expect(res.headers.location).toContain('google=state_invalido');
    expect(trocarCodigoPorTokens).not.toHaveBeenCalled();
  });

  it('REPLAY: o mesmo state usado duas vezes falha na segunda', async () => {
    const state = stateFor(USER_A);
    const first = await request(app).get(`/auth/google/callback?code=abc&state=${state}`);
    expect(first.headers.location).toContain('google=conectado');
    trocarCodigoPorTokens.mockClear();
    const second = await request(app).get(`/auth/google/callback?code=abc&state=${state}`);
    expect(second.headers.location).toContain('google=state_invalido');
    expect(trocarCodigoPorTokens).not.toHaveBeenCalled();
  });

  it('USUÁRIO diferente / desativado: state de A não conecta se A foi desativado', async () => {
    const state = stateFor(USER_A);
    db.tables.users.find((u) => u.id === USER_A).ativo = false;
    const res = await request(app).get(`/auth/google/callback?code=abc&state=${state}`);
    expect(res.headers.location).toContain('google=erro');
    expect(db.tables.google_tokens).toHaveLength(0);
  });

  it('TENANT diferente: o token é sempre gravado para o userId do state (servidor), nunca para outro', async () => {
    const state = stateFor(USER_A);
    // Um atacante não tem como fazer os tokens irem para USER_B — o callback
    // ignora tudo do query string exceto `code`.
    const res = await request(app).get(`/auth/google/callback?code=abc&state=${state}&user_id=${USER_B}`);
    expect(res.headers.location).toContain('google=conectado');
    expect(db.tables.google_tokens.find((r) => r.user_id === USER_B)).toBeUndefined();
    expect(db.tables.google_tokens.find((r) => r.user_id === USER_A)).toBeTruthy();
  });

  it('REDIRECT allowlist: só origens configuradas são aceitas como base de redirect', async () => {
    const { isAllowedRedirectBase } = await import('../src/lib/oauthState.js');
    expect(isAllowedRedirectBase('https://app.test/#/agenda?google=ok')).toBe(true);
    expect(isAllowedRedirectBase('https://evil.example/#/agenda')).toBe(false);
    expect(isAllowedRedirectBase('javascript:alert(1)')).toBe(false);
    expect(isAllowedRedirectBase('not a url')).toBe(false);
  });
});
