// producao real: doctors_status_check só aceita ('ativo','prospect','pausado',
// 'encerrado') — confirmado por leitura direta no Supabase de produção
// (nixzgeqxludxafeapsdz). 'pendente' NUNCA foi um valor válido dessa
// constraint; usá-lo em qualquer INSERT de doctors quebra com 23514. Este
// arquivo garante, em dois níveis, que isso não volta:
//  1) comportamental — POST /doctors grava 'prospect';
//  2) estático — nenhum caminho de criação de doctor no backend escreve
//     literalmente 'pendente' nesse campo, mesmo em código futuro.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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

const ADMIN = '00000000-0000-4000-8000-00000000ad01';
const OWNER = '00000000-0000-4000-8000-00000000ow01';

beforeEach(() => {
  db = makeDb({
    users: [
      { id: ADMIN, role: 'admin', ativo: true },
      { id: OWNER, role: 'doctor', ativo: false, status: 'pending' },
    ],
  });
  db.setAuthUser('admin', { id: ADMIN });
});

describe('POST /doctors — status inicial', () => {
  it('cria o doctor com status prospect, nunca pendente', async () => {
    const res = await request(app)
      .post('/doctors')
      .set('Authorization', 'Bearer admin')
      .send({ nome: 'Clinica Nova', owner_user_id: OWNER });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('prospect');
    const doctor = db.tables.doctors.find((d) => d.owner_user_id === OWNER);
    expect(doctor.status).toBe('prospect');
  });
});

describe('nenhum caminho de criação de doctor grava status=pendente (guarda estática)', () => {
  const backendRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const filesToScan = [
    'src/routes/doctors.js',
    'src/routes/signup.js',
    'src/routes/planos.js',
    'migrations/0019_signup_tenant_provisioning.sql',
    'migrations/0008_tenant_core.sql',
  ];

  it.each(filesToScan)('%s não contém status pendente em insert de doctors', (relPath) => {
    const contents = readFileSync(path.join(backendRoot, relPath), 'utf8');
    // Pega tanto o padrão JS (`status: 'pendente'`) quanto o SQL
    // (`'pendente', 'gratuito'` nos values de um insert into doctors).
    expect(contents).not.toMatch(/status:\s*['"]pendente['"]/);
    expect(contents).not.toMatch(/'pendente',\s*'gratuito'/);
  });
});
