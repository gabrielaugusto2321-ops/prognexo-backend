import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// FRONTEND_URL fora da allowlist do CORS: o callback NÃO pode redirecionar
// o navegador para fora — responde 400.
process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
process.env.FRONTEND_URL = 'https://not-allowed.example';

const db = makeDb({ users: [{ id: 'u1', role: 'doctor', ativo: true }], google_tokens: [] });
vi.mock('../src/lib/supabase.js', () => ({ supabase: db.client }));
vi.mock('../src/lib/googleCalendar.js', () => ({
  buildAuthUrl: (s) => `https://accounts.google.com/x?state=${s}`,
  trocarCodigoPorTokens: vi.fn(async () => ({ refresh_token: 'r', access_token: 'a', expiry_date: 0 })),
  estaConectado: vi.fn(async () => false),
}));

const { createApp } = await import('../src/server.js');
const app = createApp();
const { createOAuthState } = await import('../src/lib/oauthState.js');

describe('OAuth Google — redirect não permitido', () => {
  it('state inválido + base de redirect fora da allowlist → 400, sem Location externo', async () => {
    const res = await request(app).get('/auth/google/callback?code=abc&state=lixo');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('redirect_not_allowed');
    expect(res.headers.location).toBeUndefined();
  });

  it('state válido + base fora da allowlist → 200 JSON (nunca redireciona para fora)', async () => {
    const state = createOAuthState({ userId: 'u1', role: 'doctor', flow: 'google_calendar' });
    const res = await request(app).get(`/auth/google/callback?code=abc&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    expect(db.tables.google_tokens.find((r) => r.user_id === 'u1')).toBeTruthy();
  });
});
