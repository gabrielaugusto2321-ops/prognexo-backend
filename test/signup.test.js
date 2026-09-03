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
vi.mock('../src/lib/captcha.js', () => ({ verifyCaptcha: vi.fn(async () => true) }));

const { app } = await import('../src/server.js');

beforeEach(() => {
  db = makeDb({
    users: [{ id: 'existing-uuid', email: 'ja@existe.test', role: 'doctor', ativo: true }],
  });
});

describe('POST /signup (comportamental)', () => {
  it('ignora plano/role do body: conta nasce doctor + gratuito + pending + inativa', async () => {
    const res = await request(app)
      .post('/signup')
      .send({ nome: 'Fulano', email: 'novo@a.test', plano: 'pago', role: 'admin', ativo: true, status: 'active' });
    expect(res.status).toBe(202);
    const user = db.tables.users.find((u) => u.email === 'novo@a.test');
    expect(user.role).toBe('doctor');
    expect(user.ativo).toBe(false);
    expect(user.status).toBe('pending');
    const doctor = db.tables.doctors.find((d) => d.owner_user_id === user.id);
    expect(doctor.plano).toBe('gratuito');
  });

  it('anti-enumeração: e-mail já existente responde 202 igual a um novo', async () => {
    const novo = await request(app).post('/signup').send({ nome: 'Fulano', email: 'outro@a.test' });
    const existente = await request(app).post('/signup').send({ nome: 'Fulano', email: 'ja@existe.test' });
    expect(novo.status).toBe(202);
    expect(existente.status).toBe(202);
    expect(existente.body).toEqual(novo.body);
    // não criou uma segunda conta para o e-mail existente
    expect(db.tables.users.filter((u) => u.email === 'ja@existe.test')).toHaveLength(1);
  });

  it('payload inválido → 400', async () => {
    const res = await request(app).post('/signup').send({ nome: 'A' });
    expect(res.status).toBe(400);
  });
});
