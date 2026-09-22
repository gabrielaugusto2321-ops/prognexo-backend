import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

let db;
const envState = { NODE_ENV: 'production', PUBLIC_SIGNUP_ENABLED: 'false' };
vi.mock('../src/config/env.js', () => ({ env: envState }));
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/captcha.js', () => ({ verifyCaptcha: vi.fn(async () => true) }));
vi.mock('../src/middleware/rateLimits.js', () => ({
  signupHourlyLimiter: (_req, _res, next) => next(), signupDailyLimiter: (_req, _res, next) => next(), activationLimiter: (_req, _res, next) => next(),
}));
const signup = (await import('../src/routes/signup.js')).default;
const activation = (await import('../src/routes/activation.js')).default;
const api = express().use(express.json()).use('/signup', signup).use('/activation', activation);

beforeEach(() => { envState.PUBLIC_SIGNUP_ENABLED = 'false'; db = makeDb({ users: [{ id: 'active-user', ativo: true, status: 'active' }] }); });

describe('public signup gate', () => {
  it('returns honest 503 when unset/false', async () => {
    const response = await request(api).post('/signup').send({ nome: 'Fulano', email: 'novo@test.com' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'signup_temporarily_unavailable' });
    expect(db.client.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it('preserves existing signup behavior when explicitly enabled', async () => {
    envState.PUBLIC_SIGNUP_ENABLED = 'true';
    const response = await request(api).post('/signup').send({ nome: 'Fulano', email: 'novo@test.com' });
    expect(response.status).toBe(202);
    expect(db.client.auth.admin.inviteUserByEmail).toHaveBeenCalledOnce();
  });
  it.each(['false', 'true'])('activation is unaffected when flag=%s', async (flag) => {
    envState.PUBLIC_SIGNUP_ENABLED = flag;
    db.setAuthUser('confirmed', { id: 'active-user', email_confirmed_at: new Date().toISOString() });
    const response = await request(api).post('/activation/complete').set({ Authorization: 'Bearer confirmed' }).send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, status: 'active' });
  });
});
