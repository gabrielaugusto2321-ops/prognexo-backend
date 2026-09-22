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
vi.mock('../src/middleware/rateLimits.js', async (importOriginal) => ({
  ...(await importOriginal()),
  signupHourlyLimiter: (_req, _res, next) => next(),
  signupDailyLimiter: (_req, _res, next) => next(),
}));

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
    // redirectTo explícito: nunca depender da Site URL do painel Supabase
    // (foi exatamente a ausência disso que quebrou o primeiro onboarding real).
    expect(db.client.auth.admin.inviteUserByEmail).toHaveBeenCalledWith(
      'novo@a.test',
      expect.objectContaining({ redirectTo: expect.stringMatching(/^https?:\/\/.+\/$/) }),
    );
    const [, inviteOptions] = db.client.auth.admin.inviteUserByEmail.mock.calls[0];
    expect(inviteOptions.redirectTo).not.toContain('vercel.app');
    const user = db.tables.users.find((u) => u.email === 'novo@a.test');
    expect(user.role).toBe('doctor');
    expect(user.ativo).toBe(false);
    expect(user.status).toBe('pending');
    const doctor = db.tables.doctors.find((d) => d.owner_user_id === user.id);
    expect(doctor.plano).toBe('gratuito');
    // doctors_status_check em produção não aceita 'pendente' — o doctor nasce
    // 'prospect' e só vira 'ativo' em POST /activation/complete.
    expect(doctor.status).toBe('prospect');
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

  it('provisiona organizacao, unidade e membership owner completos', async () => {
    const res = await request(app).post('/signup').send({ nome: 'Fulano', clinica: 'Clinica Alfa', email: 'tenant@a.test' });
    expect(res.status).toBe(202);
    const user = db.tables.users.find((u) => u.email === 'tenant@a.test');
    const doctor = db.tables.doctors.find((d) => d.owner_user_id === user.id);
    expect(db.tables.organizations).toHaveLength(1);
    const organization = db.tables.organizations[0];
    expect(db.tables.units).toHaveLength(1);
    const unit = db.tables.units[0];
    expect(unit.organization_id).toBe(organization.id);
    expect(db.tables.organization_doctor_map).toEqual([{
      organization_id: organization.id,
      doctor_id: doctor.id,
      default_unit_id: unit.id,
    }]);
    expect(db.tables.memberships).toHaveLength(1);
    const membership = db.tables.memberships[0];
    expect(membership).toMatchObject({
      organization_id: organization.id,
      user_id: user.id,
      role: 'organization_owner',
      status: 'active',
    });
    expect(db.tables.membership_units).toEqual([{ membership_id: membership.id, unit_id: unit.id }]);
  });

  it('falha da RPC compensa auth user sem deixar linhas parciais', async () => {
    db.client.rpc.mockResolvedValueOnce({ data: null, error: { message: 'simulated rpc failure' } });
    const res = await request(app).post('/signup').send({ nome: 'Fulano', email: 'falha@a.test' });
    expect(res.status).toBe(202);
    expect(db.client.auth.admin.deleteUser).toHaveBeenCalledWith('invited-falha@a.test');
    expect(db.tables.users.filter((u) => u.email === 'falha@a.test')).toHaveLength(0);
    for (const name of ['doctors', 'organizations', 'units', 'organization_doctor_map', 'memberships', 'membership_units']) {
      expect(db.tables[name] || []).toHaveLength(0);
    }
  });

  it('RPC repetida para o mesmo auth user nao duplica o tenant', async () => {
    const params = { p_auth_user_id: 'same-user', p_nome: 'Fulano', p_email: 'same@a.test', p_clinica_nome: 'Clinica' };
    const first = await db.client.rpc('signup_provision_tenant', params);
    const second = await db.client.rpc('signup_provision_tenant', params);
    expect(first.error).toBeNull();
    expect(second).toEqual(first);
    expect(db.tables.users.filter((u) => u.id === 'same-user')).toHaveLength(1);
    for (const name of ['doctors', 'organizations', 'units', 'organization_doctor_map', 'memberships', 'membership_units']) {
      expect(db.tables[name]).toHaveLength(1);
    }
  });

  it('estado parcial — doctor + organization_doctor_map existentes, membership ausente: completa sem duplicar', async () => {
    // Simula um tenant que ficou pela metade (ex.: versão anterior da função,
    // ou uma falha entre os passos) — doctor e mapeamento já existem, mas
    // nunca chegou a criar a membership do owner.
    db = makeDb({
      users: [{ id: 'partial-user', email: 'parcial@a.test', role: 'doctor', ativo: false, status: 'pending' }],
      doctors: [{ id: 'doctor-1', owner_user_id: 'partial-user', nome: 'Clinica Parcial', status: 'prospect', plano: 'gratuito' }],
      organizations: [{ id: 'org-1', name: 'Clinica Parcial', slug: 'org-doctor-1', status: 'active' }],
      units: [{ id: 'unit-1', organization_id: 'org-1', name: 'Unidade principal', status: 'active', timezone: 'America/Sao_Paulo' }],
      organization_doctor_map: [{ organization_id: 'org-1', doctor_id: 'doctor-1', default_unit_id: 'unit-1' }],
    });

    const { data, error } = await db.client.rpc('signup_provision_tenant', {
      p_auth_user_id: 'partial-user',
      p_nome: 'Fulano',
      p_email: 'parcial@a.test',
      p_clinica_nome: 'Clinica Parcial',
    });

    expect(error).toBeNull();
    expect(data[0]).toEqual({ doctor_id: 'doctor-1', organization_id: 'org-1', unit_id: 'unit-1', membership_id: expect.any(String) });
    expect(db.tables.doctors).toHaveLength(1);
    expect(db.tables.organizations).toHaveLength(1);
    expect(db.tables.units).toHaveLength(1);
    expect(db.tables.organization_doctor_map).toHaveLength(1);
    expect(db.tables.memberships).toHaveLength(1);
    expect(db.tables.memberships[0]).toMatchObject({ organization_id: 'org-1', user_id: 'partial-user', role: 'organization_owner', status: 'active' });
    expect(db.tables.membership_units).toHaveLength(1);
    expect(db.tables.membership_units[0]).toEqual({ membership_id: db.tables.memberships[0].id, unit_id: 'unit-1' });
  });

  it('estado parcial — membership existente, membership_units ausente: completa sem duplicar', async () => {
    db = makeDb({
      users: [{ id: 'partial-user-2', email: 'parcial2@a.test', role: 'doctor', ativo: false, status: 'pending' }],
      doctors: [{ id: 'doctor-2', owner_user_id: 'partial-user-2', nome: 'Clinica Parcial 2', status: 'prospect', plano: 'gratuito' }],
      organizations: [{ id: 'org-2', name: 'Clinica Parcial 2', slug: 'org-doctor-2', status: 'active' }],
      units: [{ id: 'unit-2', organization_id: 'org-2', name: 'Unidade principal', status: 'active', timezone: 'America/Sao_Paulo' }],
      organization_doctor_map: [{ organization_id: 'org-2', doctor_id: 'doctor-2', default_unit_id: 'unit-2' }],
      memberships: [{ id: 'membership-2', organization_id: 'org-2', user_id: 'partial-user-2', role: 'organization_owner', status: 'active' }],
    });

    const { data, error } = await db.client.rpc('signup_provision_tenant', {
      p_auth_user_id: 'partial-user-2',
      p_nome: 'Fulano',
      p_email: 'parcial2@a.test',
      p_clinica_nome: 'Clinica Parcial 2',
    });

    expect(error).toBeNull();
    expect(data[0]).toEqual({ doctor_id: 'doctor-2', organization_id: 'org-2', unit_id: 'unit-2', membership_id: 'membership-2' });
    expect(db.tables.memberships).toHaveLength(1);
    expect(db.tables.membership_units).toHaveLength(1);
    expect(db.tables.membership_units[0]).toEqual({ membership_id: 'membership-2', unit_id: 'unit-2' });

    // Chamar de novo não duplica a membership_units já completa.
    await db.client.rpc('signup_provision_tenant', {
      p_auth_user_id: 'partial-user-2',
      p_nome: 'Fulano',
      p_email: 'parcial2@a.test',
      p_clinica_nome: 'Clinica Parcial 2',
    });
    expect(db.tables.membership_units).toHaveLength(1);
  });
});
