import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));

const { app } = await import('../src/server.js');

const PENDING = 'pending-uuid';
const OTHER = 'other-uuid';

beforeEach(() => {
  db = makeDb({
    users: [
      { id: PENDING, email: 'p@a.test', role: 'doctor', ativo: false, status: 'pending' },
      { id: OTHER, email: 'o@a.test', role: 'doctor', ativo: false, status: 'pending' },
    ],
    doctors: [{ id: 'doc1', owner_user_id: PENDING, status: 'pendente' }],
  });
  // token 'ok' = usuário PENDING com e-mail confirmado
  db.setAuthUser('ok', { id: PENDING, email: 'p@a.test', email_confirmed_at: '2026-01-01T00:00:00Z' });
  // token 'unconfirmed' = usuário sem e-mail confirmado
  db.setAuthUser('unconfirmed', { id: OTHER, email: 'o@a.test', email_confirmed_at: null });
});

const post = (token) =>
  request(app)
    .post('/activation/complete')
    .set(token ? { Authorization: `Bearer ${token}` } : {})
    .send({ id: 'qualquer', email: 'attacker@evil.test', role: 'admin' }); // body é ignorado

describe('POST /activation/complete (comportamental)', () => {
  it('sem token → 401', async () => expect((await post()).status).toBe(401));

  it('JWT inválido → 401', async () => expect((await post('lixo')).status).toBe(401));

  it('e-mail não confirmado → 403', async () => {
    const res = await post('unconfirmed');
    expect(res.status).toBe(403);
    expect(db.tables.users.find((u) => u.id === OTHER).ativo).toBe(false);
  });

  it('ativação válida: define ativo=true e status=active (só a própria conta do token)', async () => {
    const res = await post('ok');
    expect(res.status).toBe(200);
    const user = db.tables.users.find((u) => u.id === PENDING);
    expect(user.ativo).toBe(true);
    expect(user.status).toBe('active');
    // o body com id/email/role de outra conta NÃO afetou nada
    expect(db.tables.users.find((u) => u.email === 'attacker@evil.test')).toBeUndefined();
    expect(db.tables.doctors.find((d) => d.owner_user_id === PENDING).status).toBe('ativo');
  });

  it('idempotente: segunda chamada devolve o mesmo 200', async () => {
    const first = await post('ok');
    const second = await post('ok');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });
});
