// Hotfix: Agenda não tinha como editar/cancelar um evento criado por engano,
// e o status podia ser marcado "compareceu"/"faltou" mesmo pra eventos no
// futuro. Este teste cobre PATCH /events/:id, DELETE /events/:id, e o novo
// bloqueio de horário em PATCH /events/:id/status.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

const uuid = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const U = {
  ownerA: uuid(1), ownerB: uuid(2), closerA1: uuid(3), closerA2: uuid(4),
  docA: uuid(5), docB: uuid(6),
  evtPendente: 'e0000001-0000-4000-8000-000000000000',
  evtGoogle: 'e0000002-0000-4000-8000-000000000000',
  evtConcluido: 'e0000003-0000-4000-8000-000000000000',
  evtFuturo: 'e0000004-0000-4000-8000-000000000000',
  evtCancelado: 'e0000005-0000-4000-8000-000000000000',
  evtB: 'e0000006-0000-4000-8000-000000000000',
  evtIniciado: 'e0000007-0000-4000-8000-000000000000',
};

let db;
vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage: vi.fn(async () => ({})), sendWhatsAppTemplate: vi.fn(async () => ({ messageId: 'wamid.mock' })) }));
vi.mock('../src/lib/googleCalendar.js', () => ({
  criarEventoNoGoogle: vi.fn(async () => null),
  temConflito: vi.fn(async () => false),
  buildAuthUrl: () => '#',
  trocarCodigoPorTokens: vi.fn(),
  estaConectado: vi.fn(async () => false),
}));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));

const { app } = await import('../src/server.js');
const as = (token) => ({ Authorization: `Bearer ${token}` });

const PASSADO_INICIO = '2026-01-01T10:00:00.000Z';
const PASSADO_FIM = '2026-01-01T11:00:00.000Z';
const FUTURO_INICIO = '2099-01-01T10:00:00.000Z';
const FUTURO_FIM = '2099-01-01T11:00:00.000Z';

beforeEach(() => {
  db = makeDb({
    users: [
      { id: U.ownerA, role: 'doctor', ativo: true, nome: 'A' },
      { id: U.ownerB, role: 'doctor', ativo: true, nome: 'B' },
      { id: U.closerA1, role: 'closer', ativo: true, nome: 'C1' },
      { id: U.closerA2, role: 'closer', ativo: true, nome: 'C2' },
    ],
    doctors: [
      { id: U.docA, owner_user_id: U.ownerA, plano: 'gratuito' },
      { id: U.docB, owner_user_id: U.ownerB, plano: 'gratuito' },
    ],
    user_doctor_access: [
      { user_id: U.closerA1, doctor_id: U.docA },
      { user_id: U.closerA2, doctor_id: U.docA },
    ],
    events: [
      { id: U.evtPendente, doctor_id: U.docA, responsavel_id: U.closerA1, status: 'pendente', inicio: PASSADO_INICIO, fim: PASSADO_FIM, titulo: 'Original', tipo: 'venda', google_event_id: null },
      { id: U.evtGoogle, doctor_id: U.docA, responsavel_id: U.closerA1, status: 'pendente', inicio: PASSADO_INICIO, fim: PASSADO_FIM, titulo: 'Sincronizado', tipo: 'venda', google_event_id: 'g-123' },
      { id: U.evtConcluido, doctor_id: U.docA, responsavel_id: U.closerA1, status: 'compareceu', inicio: PASSADO_INICIO, fim: PASSADO_FIM, titulo: 'Já concluído', tipo: 'venda', google_event_id: null },
      { id: U.evtFuturo, doctor_id: U.docA, responsavel_id: U.closerA1, status: 'pendente', inicio: FUTURO_INICIO, fim: FUTURO_FIM, titulo: 'Futuro', tipo: 'venda', google_event_id: null },
      { id: U.evtCancelado, doctor_id: U.docA, responsavel_id: U.closerA1, status: 'cancelado', inicio: PASSADO_INICIO, fim: PASSADO_FIM, titulo: 'Já cancelado', tipo: 'venda', google_event_id: null },
      { id: U.evtB, doctor_id: U.docB, responsavel_id: U.ownerB, status: 'pendente', inicio: PASSADO_INICIO, fim: PASSADO_FIM, titulo: 'Da clínica B', tipo: 'venda', google_event_id: null },
      { id: U.evtIniciado, doctor_id: U.docA, responsavel_id: U.closerA1, status: 'pendente', inicio: PASSADO_INICIO, fim: PASSADO_FIM, titulo: 'Já começou', tipo: 'venda', google_event_id: null },
    ],
  });
  db.setAuthUser('ownerA', { id: U.ownerA });
  db.setAuthUser('ownerB', { id: U.ownerB });
  db.setAuthUser('c1', { id: U.closerA1 });
  db.setAuthUser('c2', { id: U.closerA2 });
});

describe('PATCH /events/:id — edição', () => {
  it('edição válida no próprio tenant: título/tipo/data/hora mudam', async () => {
    const res = await request(app).patch(`/events/${U.evtPendente}`).set(as('ownerA')).send({ titulo: 'Novo título', tipo: 'paciente' });
    expect(res.status).toBe(200);
    expect(res.body.titulo).toBe('Novo título');
    expect(res.body.tipo).toBe('paciente');
  });

  it('só `inicio` muda: preserva a duração original (1h)', async () => {
    const novoInicio = '2026-01-05T08:00:00.000Z';
    const res = await request(app).patch(`/events/${U.evtPendente}`).set(as('ownerA')).send({ inicio: novoInicio });
    expect(res.status).toBe(200);
    expect(res.body.inicio).toBe(novoInicio);
    expect(new Date(res.body.fim).getTime() - new Date(res.body.inicio).getTime()).toBe(60 * 60 * 1000);
  });

  it('payload vazio: 400', async () => {
    const res = await request(app).patch(`/events/${U.evtPendente}`).set(as('ownerA')).send({});
    expect(res.status).toBe(400);
  });

  it('payload inválido (chave desconhecida): 400', async () => {
    const res = await request(app).patch(`/events/${U.evtPendente}`).set(as('ownerA')).send({ doctor_id: U.docB });
    expect(res.status).toBe(400);
  });

  it('fim anterior ao início (ambos enviados): 400', async () => {
    const res = await request(app).patch(`/events/${U.evtPendente}`).set(as('ownerA')).send({
      inicio: '2026-01-05T10:00:00.000Z',
      fim: '2026-01-05T09:00:00.000Z',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('fim_before_inicio');
  });

  it('evento não pendente (já concluído): 409 event_not_editable', async () => {
    const res = await request(app).patch(`/events/${U.evtConcluido}`).set(as('ownerA')).send({ titulo: 'tentando editar' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('event_not_editable');
  });

  it('cross-tenant: doctor A não edita evento da clínica B', async () => {
    const res = await request(app).patch(`/events/${U.evtB}`).set(as('ownerA')).send({ titulo: 'invasão' });
    expect(res.status).toBe(403);
    expect(db.tables.events.find((e) => e.id === U.evtB).titulo).toBe('Da clínica B');
  });

  it('closer sem propriedade do evento: 403', async () => {
    const res = await request(app).patch(`/events/${U.evtPendente}`).set(as('c2')).send({ titulo: 'não sou dono' });
    expect(res.status).toBe(403);
  });

  it('closer dono do evento: edita normalmente', async () => {
    const res = await request(app).patch(`/events/${U.evtPendente}`).set(as('c1')).send({ titulo: 'closer edita' });
    expect(res.status).toBe(200);
  });

  it('evento sincronizado com o Google: 409 google_synced_event_not_editable', async () => {
    const res = await request(app).patch(`/events/${U.evtGoogle}`).set(as('ownerA')).send({ titulo: 'tentando' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('google_synced_event_not_editable');
    expect(db.tables.events.find((e) => e.id === U.evtGoogle).titulo).toBe('Sincronizado');
  });
});

describe('DELETE /events/:id — cancelamento lógico', () => {
  it('cancelamento lógico: status vira cancelado, linha continua existindo', async () => {
    const res = await request(app).delete(`/events/${U.evtPendente}`).set(as('ownerA'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelado');
    expect(db.tables.events.find((e) => e.id === U.evtPendente)).toBeTruthy();
  });

  it('cancelamento idempotente: cancelar de novo não é erro', async () => {
    const res = await request(app).delete(`/events/${U.evtCancelado}`).set(as('ownerA'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelado');
  });

  it('cross-tenant: doctor A não cancela evento da clínica B', async () => {
    const res = await request(app).delete(`/events/${U.evtB}`).set(as('ownerA'));
    expect(res.status).toBe(403);
    expect(db.tables.events.find((e) => e.id === U.evtB).status).toBe('pendente');
  });

  it('evento sincronizado com o Google: 409 google_synced_event_not_cancellable', async () => {
    const res = await request(app).delete(`/events/${U.evtGoogle}`).set(as('ownerA'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('google_synced_event_not_cancellable');
    expect(db.tables.events.find((e) => e.id === U.evtGoogle).status).toBe('pendente');
  });
});

describe('PATCH /events/:id/status — bloqueio de evento futuro', () => {
  it('evento futuro + "compareceu": 409 event_not_started', async () => {
    const res = await request(app).patch(`/events/${U.evtFuturo}/status`).set(as('ownerA')).send({ status: 'compareceu' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('event_not_started');
  });

  it('evento futuro + "faltou": 409 event_not_started', async () => {
    const res = await request(app).patch(`/events/${U.evtFuturo}/status`).set(as('ownerA')).send({ status: 'faltou' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('event_not_started');
  });

  it('evento já iniciado (no passado): mantém o comportamento atual — "compareceu" funciona e cria atendimento se houver lead_id', async () => {
    const res = await request(app).patch(`/events/${U.evtIniciado}/status`).set(as('ownerA')).send({ status: 'compareceu' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('compareceu');
  });

  it('evento já iniciado + "faltou": continua funcionando normalmente', async () => {
    const res = await request(app).patch(`/events/${U.evtIniciado}/status`).set(as('ownerA')).send({ status: 'faltou' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('faltou');
  });
});
