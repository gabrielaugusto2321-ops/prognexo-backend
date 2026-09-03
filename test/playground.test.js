import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
const processarMensagemComIA = vi.fn(async () => ({ resposta: 'ok', status: 'qualificando', score: 0 }));

vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));
vi.mock('../src/lib/iaAgent.js', () => ({ processarMensagemComIA }));
vi.mock('../src/lib/knowledgeChunks.js', () => ({ buscarChunksRelevantes: vi.fn(async () => []) }));

const { app } = await import('../src/server.js');

const DOC = '00000000-0000-4000-8000-0000000000d1';
const USER = '00000000-0000-4000-8000-0000000000u1';

beforeEach(() => {
  processarMensagemComIA.mockClear();
  db = makeDb({
    users: [{ id: USER, role: 'admin', ativo: true }],
    doctors: [{ id: DOC, ia_nome_agente: 'Ana', ia_contexto: 'x' }],
  });
  db.setAuthUser('admin', { id: USER });
});

const call = (historico, extra = {}) =>
  request(app)
    .post('/playground/simular')
    .set({ Authorization: 'Bearer admin' })
    .send({ doctor_id: DOC, historico, ...extra });

describe('POST /playground/simular — hard caps (comportamental)', () => {
  it('mensagem gigante é rejeitada ANTES da chamada de IA', async () => {
    const res = await call([{ direcao: 'recebida', conteudo: 'x'.repeat(5000) }]);
    expect([400, 413]).toContain(res.status);
    expect(processarMensagemComIA).not.toHaveBeenCalled();
  });

  it('histórico com mais de 30 mensagens é rejeitado (400/413) sem chamar IA', async () => {
    const historico = Array.from({ length: 40 }, () => ({ direcao: 'recebida', conteudo: 'oi' }));
    const res = await call(historico);
    expect([400, 413]).toContain(res.status);
    expect(processarMensagemComIA).not.toHaveBeenCalled();
  });

  it('contexto de produto gigante é rejeitado sem chamar IA', async () => {
    const res = await call([{ direcao: 'recebida', conteudo: 'oi' }], { contexto_produto: 'y'.repeat(5000) });
    expect([400, 413]).toContain(res.status);
    expect(processarMensagemComIA).not.toHaveBeenCalled();
  });

  it('payload dentro dos limites chama a IA normalmente', async () => {
    const res = await call([{ direcao: 'recebida', conteudo: 'quero saber o preço' }]);
    expect(res.status).toBe(200);
    expect(processarMensagemComIA).toHaveBeenCalledTimes(1);
  });
});
