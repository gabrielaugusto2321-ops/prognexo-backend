import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
const sendCourtesyInviteEmail = vi.fn(async () => ({ id: 'mock-email' }));
vi.mock('../src/lib/emailAdapter.js', () => ({ sendCourtesyInviteEmail: (...args) => sendCourtesyInviteEmail(...args) }));
afterEach(() => { delete process.env.TENANT_CORE_ENABLED; vi.resetModules(); sendCourtesyInviteEmail.mockClear(); });

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = U(1); const PAD = U(2); const OWNER = U(3); const DOCTOR = U(4); const CLOSER = U(5);
const D1 = U(11); const ORG = U(21);
const endpoints = [
  ['get', '/admin/doctors'], ['post', '/admin/doctors'], ['post', `/admin/doctors/${D1}/resend-invite`],
  ['patch', `/admin/doctors/${D1}/pause`], ['patch', `/admin/doctors/${D1}/reactivate`],
];
const auth = (token) => ({ Authorization: `Bearer ${token}` });
async function app(flag = 'false') { vi.resetModules(); process.env.TENANT_CORE_ENABLED = flag; return (await import('../src/server.js')).createApp(); }

beforeEach(() => {
  db = makeDb({
    users: [
      { id: ADMIN, email: 'admin@test', role: 'admin', ativo: true },
      { id: PAD, email: 'pad@test', role: 'doctor', ativo: true },
      { id: OWNER, email: 'owner@test', role: 'doctor', ativo: true },
      { id: DOCTOR, email: 'doctor@test', role: 'doctor', ativo: true },
      { id: CLOSER, email: 'closer@test', role: 'closer', ativo: true },
    ],
    platform_admins: [{ user_id: PAD }],
    doctors: [{ id: D1, owner_user_id: OWNER, nome: 'Clinica A', status: 'prospect', criado_em: new Date().toISOString(), courtesy_expires_at: null }],
    organizations: [{ id: ORG, name: 'Tenant A' }],
    organization_doctor_map: [{ organization_id: ORG, doctor_id: D1 }],
    memberships: [
      { id: 'm1', organization_id: ORG, user_id: OWNER, role: 'organization_owner', status: 'active' },
      { id: 'm2', organization_id: ORG, user_id: DOCTOR, role: 'professional', status: 'active' },
      { id: 'm3', organization_id: ORG, user_id: CLOSER, role: 'closer', status: 'active' },
    ],
  });
  for (const [token, id] of [['admin', ADMIN], ['pad', PAD], ['owner', OWNER], ['doctor', DOCTOR], ['closer', CLOSER]]) db.setAuthUser(token, { id });
});

describe('admin doctors authorization', () => {
  it.each(['false', 'true'])('rejects every endpoint for every non-platform role (tenant=%s)', async (flag) => {
    const api = await app(flag);
    for (const token of ['owner', 'doctor', 'closer']) for (const [method, url] of endpoints) {
      const response = await request(api)[method](url).set(auth(token)).send(method === 'post' && url === '/admin/doctors' ? { nome: 'Novo', clinica: 'Nova', email: 'novo@test.com' } : {});
      expect(response.status, `${token} ${method} ${url}`).toBe(403);
    }
  }, 120_000);

  it.each(['admin', 'pad'])('%s can list every tenant without sensitive fields', async (token) => {
    const response = await request(await app()).get('/admin/doctors').set(auth(token));
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: D1, nome: 'Tenant A', owner_email: 'owner@test', status: 'prospect', courtesy_expires_at: null, created_at: expect.any(String) }]);
    expect(response.body[0].owner_user_id).toBeUndefined();
  });
});

describe('admin doctors mutations', () => {
  it('creates an isolated tenant and retry returns conflict without a second invite', async () => {
    const api = await app();
    const body = { nome: 'Nova Medica', clinica: 'Clinica Nova', email: 'nova@test.com', dias_cortesia: 30 };
    const first = await request(api).post('/admin/doctors').set(auth('admin')).send(body);
    expect(first.status).toBe(201);
    expect(db.tables.organization_doctor_map).toHaveLength(2);
    expect(db.tables.organization_doctor_map[1].organization_id).not.toBe(ORG);
    // Regressão do primeiro onboarding real: sem redirectTo explícito, o link
    // de convite depende da Site URL do painel do Supabase — que pode estar
    // desatualizada (domínio antigo) sem nada acusar isso nos testes.
    expect(db.client.auth.admin.inviteUserByEmail).toHaveBeenCalledWith(
      'nova@test.com',
      expect.objectContaining({ redirectTo: expect.stringMatching(/^https?:\/\/.+\/$/) }),
    );
    const second = await request(api).post('/admin/doctors').set(auth('admin')).send(body);
    expect(second.status).toBe(409);
    expect(db.client.auth.admin.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(db.tables.doctors).toHaveLength(2);
  });

  it('compensates the Auth user when provisioning fails', async () => {
    db.client.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const response = await request(await app()).post('/admin/doctors').set(auth('admin')).send({ nome: 'Falha', clinica: 'Falha Clinic', email: 'falha@test.com' });
    expect(response.status).toBe(500);
    expect(db.client.auth.admin.deleteUser).toHaveBeenCalledWith('invited-falha@test.com');
  });

  it('returns 404 for missing doctor mutations', async () => {
    for (const [method, suffix] of [['post', 'resend-invite'], ['patch', 'pause'], ['patch', 'reactivate']]) {
      const response = await request(await app())[method](`/admin/doctors/${U(999)}/${suffix}`).set(auth('admin')).send({});
      expect(response.status).toBe(404);
    }
  });

  it('rejects resend-invite for an already-active account (409 account_already_active), never generates a duplicate user', async () => {
    const activeDoctorId = U(12);
    const activeOwnerId = U(13);
    db.tables.users.push({ id: activeOwnerId, email: 'ativo@test.com', role: 'doctor', ativo: true, status: 'active' });
    db.tables.doctors.push({ id: activeDoctorId, owner_user_id: activeOwnerId, nome: 'Clinica Ativa', status: 'ativo', criado_em: new Date().toISOString(), courtesy_expires_at: null });
    const usersBefore = db.tables.users.length;

    const response = await request(await app()).post(`/admin/doctors/${activeDoctorId}/resend-invite`).set(auth('admin')).send({});
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'account_already_active' });
    expect(db.client.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(db.client.auth.admin.generateLink).not.toHaveBeenCalled();
    expect(sendCourtesyInviteEmail).not.toHaveBeenCalled();
    expect(db.tables.users).toHaveLength(usersBefore);
  });

  it('allows resend-invite only while the account is still pending/prospect', async () => {
    // D1/OWNER no fixture padrão tem ativo:true (usado nos testes de
    // autorização) — um convite pendente de verdade nunca teria isso, então
    // este teste usa um doctor+owner dedicados no estado real de "prospect".
    const pendingDoctorId = U(14);
    const pendingOwnerId = U(15);
    db.tables.users.push({ id: pendingOwnerId, email: 'pendente@test.com', role: 'doctor', ativo: false, status: 'pending' });
    db.tables.doctors.push({ id: pendingDoctorId, owner_user_id: pendingOwnerId, nome: 'Clinica Pendente', status: 'prospect', criado_em: new Date().toISOString(), courtesy_expires_at: null });

    const usersBefore = db.tables.users.length;
    const response = await request(await app()).post(`/admin/doctors/${pendingDoctorId}/resend-invite`).set(auth('admin')).send({});
    expect(response.status).toBe(200);
    // generateLink({type:'invite'}) regenera o link SEM criar um segundo
    // auth.users/doctor — nunca chama inviteUserByEmail de novo.
    expect(db.client.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(db.client.auth.admin.generateLink).toHaveBeenCalledWith({
      type: 'invite',
      email: 'pendente@test.com',
      options: { redirectTo: expect.stringMatching(/^https?:\/\/.+\/$/) },
    });
    expect(sendCourtesyInviteEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'pendente@test.com', actionLink: expect.stringContaining('pendente@test.com') }));
    expect(db.tables.users).toHaveLength(usersBefore);
  });
});
