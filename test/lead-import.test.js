import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { makeDb } from './helpers/mockSupabase.js';
import { normalizeBrazilianPhone } from '../src/lib/phoneNormalization.js';
import { processImportFile } from '../src/lib/leadImport.js';

// Helper local só pra montar o file_hash exatamente como o backend calcula
// (sha256 sobre os bytes do corpo).
const fileHashOf = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

const ownerA = '00000001-0000-4000-8000-000000000000';
const ownerB = '00000002-0000-4000-8000-000000000000';
const closer = '00000003-0000-4000-8000-000000000000';
const doctorA = '00000004-0000-4000-8000-000000000000';
const doctorB = '00000005-0000-4000-8000-000000000000';
const header = 'nome;telefone;origem;indicado_por;autorizacao_whatsapp;data_autorizacao';
const csv = (...rows) => [header, ...rows].join('\n');

let db;
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage: vi.fn(async () => ({})), sendWhatsAppTemplate: vi.fn(async () => ({ messageId: 'wamid.mock' })) }));
vi.mock('../src/lib/googleCalendar.js', () => ({ criarEventoNoGoogle: vi.fn(), temConflito: vi.fn(async () => false), buildAuthUrl: () => '#', trocarCodigoPorTokens: vi.fn(), estaConectado: vi.fn(async () => false) }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: vi.fn(async () => null) }));

const { app } = await import('../src/server.js');
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const declarado = { 'X-WhatsApp-Consent-Declared': 'true' };

beforeEach(() => {
  db = makeDb({
    users: [{ id: ownerA, role: 'doctor', ativo: true }, { id: ownerB, role: 'doctor', ativo: true }, { id: closer, role: 'closer', ativo: true }],
    doctors: [{ id: doctorA, owner_user_id: ownerA }, { id: doctorB, owner_user_id: ownerB }],
    user_doctor_access: [{ user_id: closer, doctor_id: doctorA }], leads: [], lead_imports: [], lead_import_rows: [],
  });
  db.setAuthUser('a', { id: ownerA }); db.setAuthUser('b', { id: ownerB }); db.setAuthUser('c', { id: closer });
});

describe('normalizeBrazilianPhone', () => {
  it.each([
    ['11987654321', '5511987654321', 'mobile', false],
    ['5511987654321', '5511987654321', 'mobile', false],
    ['1133334444', '551133334444', 'landline', false],
    ['551133334444', '551133334444', 'landline', false],
    ['+55 (11) 98765-4321', '5511987654321', 'mobile', false],
  ])('normaliza %s', (input, expectedCanonical, expectedKind, expectedLegacy) => {
    const r = normalizeBrazilianPhone(input);
    expect(r.valid).toBe(true);
    expect(r.canonical).toBe(expectedCanonical);
    expect(r.kind).toBe(expectedKind);
    expect(r.hadLegacyMobileFormat).toBe(expectedLegacy);
    expect(r.reason).toBe(null);
  });
  it.each(['123', '551198765432100', 'apenas letras'])('rejeita comprimento %s', (input) => expect(normalizeBrazilianPhone(input).valid).toBe(false));
  it.each(['0033334444', '1033334444', '2033334444'])('rejeita DDD inexistente/reservado (%s)', (input) => {
    const r = normalizeBrazilianPhone(input);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('ddd_invalido');
  });
  it('mantém o nono dígito intacto quando já presente (não remove)', () => {
    expect(normalizeBrazilianPhone('11987654321').canonical).toBe('5511987654321'); // 11 dígitos, com 9
  });
  it('fixo de 10 dígitos nunca ganha o nono dígito', () => {
    const r = normalizeBrazilianPhone('1133334444');
    expect(r.canonical).toBe('551133334444');
    expect(r.kind).toBe('landline');
    expect(r.hadLegacyMobileFormat).toBe(false);
  });
  it('celular sem o nono dígito (12 dígitos com DDI) é reconhecido e o 9 é inserido de forma determinística', () => {
    const r = normalizeBrazilianPhone('554396216864'); // achado real da auditoria — 12 dígitos, assinante começa em 6
    expect(r.valid).toBe(true);
    expect(r.kind).toBe('mobile');
    expect(r.hadLegacyMobileFormat).toBe(true);
    expect(r.canonical).toBe('5543996216864'); // 13 dígitos, com o 9 inserido
    expect(r.rawDigits).toBe('554396216864'); // valor original preservado em rawDigits (alias)
  });
  it('celular de 13 dígitos (já com o 9) permanece idêntico', () => {
    const r = normalizeBrazilianPhone('5543996216864');
    expect(r.valid).toBe(true);
    expect(r.kind).toBe('mobile');
    expect(r.hadLegacyMobileFormat).toBe(false);
    expect(r.canonical).toBe('5543996216864');
  });
  it('assinante de 9 dígitos que não começa em 9 é rejeitado (nunca "corrigido")', () => {
    const r = normalizeBrazilianPhone('5543186216864'); // 9 dígitos após DDD, começa em 1
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('celular_invalido');
  });
  it('assinante de 8 dígitos começando em 0/1 é rejeitado (não é fixo nem celular reconhecível)', () => {
    const r = normalizeBrazilianPhone('551112345678');
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('assinante_invalido');
  });
});

describe('CSV parser', () => {
  it.each([
    `${header}\n"Maria, Silva";11987654321;Evento;;sim;01/01/2025`,
    `nome,telefone,origem,indicado_por,autorizacao_whatsapp,data_autorizacao\nMaria,11987654321,"Evento, SP",,sim,2025-01-01`,
    `﻿${header}\nMaria;11987654321;Evento;;nao;`,
  ])('aceita delimitadores, BOM e campos entre aspas', async (body) => {
    const result = await processImportFile(Buffer.from(body), { fetchExistingPhoneMap: async () => new Map() });
    expect(result.error).toBeUndefined(); expect(result.total).toBe(1);
  });
  it('aceita quebra de linha dentro de um campo entre aspas', async () => {
    const body = `${header}\n"Maria\nSilva";11987654321;Evento;;nao;`;
    const result = await processImportFile(Buffer.from(body), { fetchExistingPhoneMap: async () => new Map() });
    expect(result.error).toBeUndefined();
    expect(result.total).toBe(1);
    expect(result.linhas[0].nome).toBe('Maria\nSilva');
  });
  it('correção 3: linha inválida não "envenena" uma linha válida posterior com o mesmo telefone', async () => {
    const body = csv(';11987654321;;;nao;', 'Maria;11987654321;;;nao;');
    const result = await processImportFile(Buffer.from(body), { fetchExistingPhoneMap: async () => new Map() });
    expect(result.linhas[0]).toMatchObject({ status: 'invalido', motivo: 'nome_obrigatorio' });
    expect(result.linhas[1]).toMatchObject({ status: 'valido', nome: 'Maria' });
  });
  it('autorização "sim" sem data válida é sempre inválida (telefones diferentes, sem interferência de duplicidade)', async () => {
    const result = await processImportFile(Buffer.from(csv('A;11987654321;;;sim;', 'B;11988888888;;;nao;')), { fetchExistingPhoneMap: async () => new Map() });
    expect(result.linhas[0]).toMatchObject({ status: 'invalido', motivo: 'autorizacao_sem_data' });
    expect(result.linhas[1].status).toBe('valido');
  });
  it('duas linhas válidas com o MESMO telefone: a segunda é duplicado_arquivo', async () => {
    const result = await processImportFile(Buffer.from(csv('A;11987654321;;;nao;', 'B;11987654321;;;nao;')), { fetchExistingPhoneMap: async () => new Map() });
    expect(result.linhas[0].status).toBe('valido');
    expect(result.linhas[1].status).toBe('duplicado_arquivo');
  });
  it('rejeita mais de 5000 linhas (parser aborta em 5001 via csv-parse `to`)', async () => {
    const body = csv(...Array.from({ length: 5001 }, (_, i) => `N${i};119876${String(i).padStart(5, '0')};;;nao;`));
    expect((await processImportFile(Buffer.from(body))).error).toBe('arquivo_excede_limite_linhas');
  });
});

describe('lead import endpoints', () => {
  it('preview não escreve e identifica existente apenas no mesmo médico', async () => {
    db.tables.leads.push({ id: 'lead-a', doctor_id: doctorA, telefone_normalizado: '5511987654321' }, { id: 'lead-b', doctor_id: doctorB, telefone_normalizado: '5511988888888' });
    const before = db.tables.leads.length;
    const res = await request(app).post(`/leads/import/preview?doctor_id=${doctorA}`).set(auth('a')).set('Content-Type', 'text/csv')
      .send(csv('A;11987654321;;;nao;', 'B;11988888888;;;nao;'));
    expect(res.status).toBe(200); expect(res.body.existentes_medico).toBe(1); expect(res.body.resumo.criar).toBe(1);
    expect(db.tables.leads).toHaveLength(before); expect(db.tables.lead_imports).toHaveLength(0);
  });
  it('reconhece formatos equivalentes (13 dígitos no CSV bate com lead existente gravado em variante legada já canonizada)', async () => {
    // Lead já existe com o canônico correto (13 dígitos, com o 9) — simula um
    // lead cujo telefone_normalizado já foi corrigido/reconciliado antes.
    db.tables.leads.push({ id: 'lead-legacy', doctor_id: doctorA, telefone_normalizado: '5543996216864' });
    const res = await request(app).post(`/leads/import/preview?doctor_id=${doctorA}`).set(auth('a')).set('Content-Type', 'text/csv')
      .send(csv('Gabriel;43996216864;;;nao;')); // 11 dígitos, formato nacional — mesmo telefone
    expect(res.status).toBe(200);
    expect(res.body.existentes_medico).toBe(1); // reconhecido como o MESMO telefone, não um novo
    expect(res.body.resumo.criar).toBe(0);
  });

  it('bloqueia cross-tenant e closer nos dois endpoints', async () => {
    for (const path of ['preview', 'commit?nome_lista=X&filename=x.csv']) {
      const separator = path.includes('?') ? '&' : '?';
      const body = csv('A;11987654321;;;nao;');
      expect((await request(app).post(`/leads/import/${path}${separator}doctor_id=${doctorB}`).set(auth('a')).set('Content-Type', 'text/csv').send(body)).status).toBe(403);
      expect((await request(app).post(`/leads/import/${path}${separator}doctor_id=${doctorA}`).set(auth('c')).set('Content-Type', 'text/csv').send(body)).status).toBe(403);
    }
  });
  it('rejeita vazio, tipo errado e corpo acima de 2 MB', async () => {
    expect((await request(app).post(`/leads/import/preview?doctor_id=${doctorA}`).set(auth('a')).set('Content-Type', 'text/csv').send('')).body.error).toBe('arquivo_vazio');
    expect((await request(app).post(`/leads/import/preview?doctor_id=${doctorA}`).set(auth('a')).send('x')).body.error).toBe('content_type_invalido');
    const large = `${header}\n${'x'.repeat(2 * 1024 * 1024)}`;
    expect((await request(app).post(`/leads/import/preview?doctor_id=${doctorA}`).set(auth('a')).set('Content-Type', 'text/csv').send(large)).body.error).toBe('arquivo_muito_grande');
  });
  it('GET /leads/imports bloqueia closer e é isolado por médico', async () => {
    db.tables.lead_imports.push({ id: 'ia', doctor_id: doctorA, nome_lista: 'A' }, { id: 'ib', doctor_id: doctorB, nome_lista: 'B' });
    expect((await request(app).get(`/leads/imports?doctor_id=${doctorA}`).set(auth('c'))).status).toBe(403);
    const own = await request(app).get(`/leads/imports?doctor_id=${doctorA}`).set(auth('a'));
    expect(own.status).toBe(200); expect(own.body.map((x) => x.id)).toEqual(['ia']);
    expect((await request(app).get(`/leads/imports?doctor_id=${doctorB}`).set(auth('a'))).status).toBe(403);
  });

  describe('correção 1 — declaração explícita de autorização', () => {
    const url = `/leads/import/commit?doctor_id=${doctorA}&nome_lista=Lista&filename=x.csv`;
    it('exige o header quando há alguma linha autorizacao_whatsapp=sim válida', async () => {
      const body = csv('A;11987654321;;;sim;2025-01-01');
      const semHeader = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
      expect(semHeader.status).toBe(400);
      expect(semHeader.body.error).toBe('authorization_declaration_required');
      expect(db.tables.leads).toHaveLength(0);
    });
    it('com o header, grava authorization_declared_by/at/version = v1 no lote', async () => {
      const body = csv('A;11987654321;;;sim;2025-01-01');
      const res = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').set(declarado).send(body);
      expect(res.status).toBe(200);
      const lote = db.tables.lead_imports.find((l) => l.id === res.body.import_id);
      expect(lote.authorization_declared_by).toBe(ownerA);
      expect(lote.authorization_declared_at).toBeTruthy();
      expect(lote.authorization_declaration_version).toBe('v1');
    });
    it('sem nenhuma linha autorizada, a declaração permanece nula mesmo sem o header', async () => {
      const body = csv('A;11987654321;;;nao;');
      const res = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
      expect(res.status).toBe(200);
      const lote = db.tables.lead_imports.find((l) => l.id === res.body.import_id);
      expect(lote.authorization_declared_at).toBeFalsy();
    });
    it('created_by sozinho nunca substitui a declaração — mesmo header ausente com created_by presente, 400', async () => {
      const body = csv('A;11987654321;;;sim;2025-01-01');
      const res = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body); // sem o header
      expect(res.status).toBe(400);
      expect(db.tables.lead_imports).toHaveLength(0); // nada foi criado só por causa do created_by/JWT
    });
  });

  it('commit é idempotente e não reverte opt_out', async () => {
    db.tables.leads.push({ id: 'existing', doctor_id: doctorA, telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'opt_out' });
    const body = csv('A;11987654321;Feira;Joao;sim;2025-01-01', 'B;11988888888;;;nao;');
    const url = `/leads/import/commit?doctor_id=${doctorA}&nome_lista=Lista&filename=x.csv`;
    const first = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').set(declarado).send(body);
    expect(first.status).toBe(200); expect(db.tables.leads.find((l) => l.id === 'existing').whatsapp_authorization_status).toBe('opt_out');
    const leadCount = db.tables.leads.length;
    const second = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').set(declarado).send(body);
    expect(second.status).toBe(200); expect(second.body.ja_processado).toBe(true); expect(db.tables.leads).toHaveLength(leadCount); expect(db.tables.lead_imports).toHaveLength(1);
    expect(db.tables.deals).toHaveLength(2);
  });

  it('cria um cartão por contato importado, na etapa lead, sem autorizar mensagens', async () => {
    const body = csv('Alfa;11987654321;;;nao;', 'Beta;11988888888;;;nao;', 'Gama;11977777777;;;nao;');
    const res = await request(app).post(`/leads/import/commit?doctor_id=${doctorA}&nome_lista=Teste&filename=teste.csv`)
      .set(auth('a')).set('Content-Type', 'text/csv').send(body);
    expect(res.status).toBe(200);
    expect(db.tables.deals).toHaveLength(3);
    expect(new Set(db.tables.deals.map((d) => d.lead_id)).size).toBe(3);
    expect(db.tables.deals.every((d) => d.etapa === 'lead')).toBe(true);
    expect(db.tables.leads.every((l) => l.whatsapp_authorization_status === 'pendente')).toBe(true);
  });

  it('reenvio do mesmo CSV repara os cartões de um lote antigo concluído sem duplicar leads ou deals', async () => {
    const body = csv('Alfa;11987654321;;;nao;', 'Beta;11988888888;;;nao;', 'Gama;11977777777;;;nao;');
    const url = `/leads/import/commit?doctor_id=${doctorA}&nome_lista=Teste&filename=teste.csv`;
    const first = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
    expect(first.status).toBe(200);
    db.tables.deals.splice(0, 3); // simula o lote criado antes desta correção
    const second = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
    expect(second.status).toBe(200);
    expect(second.body.ja_processado).toBe(true);
    expect(db.tables.leads).toHaveLength(3);
    expect(db.tables.deals).toHaveLength(3);
    const third = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
    expect(third.status).toBe(200);
    expect(db.tables.deals).toHaveLength(3);
  });

  it('correção 0018 — dois reenvios simultâneos do mesmo CSV reparando o mesmo lote concluído: exatamente um cartão por lead, nunca 500', async () => {
    const body = csv('Alfa;11987654321;;;nao;', 'Beta;11988888888;;;nao;', 'Gama;11977777777;;;nao;');
    const url = `/leads/import/commit?doctor_id=${doctorA}&nome_lista=Teste&filename=teste.csv`;
    const first = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
    expect(first.status).toBe(200);
    // Simula um lote concluído ANTES desta correção — sem nenhum cartão ainda.
    db.tables.deals.splice(0, db.tables.deals.length);
    const leadIds = db.tables.leads.map((l) => l.id);

    const [r1, r2] = await Promise.all([
      request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body),
      request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(db.tables.leads).toHaveLength(3); // nenhum lead duplicado
    expect(db.tables.deals).toHaveLength(3); // exatamente um cartão por lead, nunca dois
    expect(new Set(db.tables.deals.map((d) => d.lead_id))).toEqual(new Set(leadIds));
  });

  it('correção 0018 — corrida forçada entre o SELECT e o INSERT do cartão: 23505 nunca vira 500, nunca duplica (determinístico, não depende de timing real)', async () => {
    // O teste acima com Promise.all é um smoke test de integração honesto,
    // mas essa janela de corrida é curta demais pra depender de como o
    // Node agenda as duas requisições — passa mesmo se a correção for
    // removida (ver histórico: comprovado retirando o guard e rodando só
    // esse teste, que passou de qualquer jeito). Este aqui força a janela
    // de propósito: injeta o "cartão concorrente" bem no meio do SELECT
    // desta própria execução, então o INSERT dela SEMPRE bate no 23505.
    const body = csv('Alfa;11987654321;;;nao;');
    const url = `/leads/import/commit?doctor_id=${doctorA}&nome_lista=Teste&filename=teste.csv`;
    const first = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
    expect(first.status).toBe(200);
    const leadId = db.tables.leads[0].id;
    db.tables.deals.splice(0, db.tables.deals.length); // simula lote concluído sem cartão ainda

    const originalFrom = db.client.from;
    let injected = false;
    db.client.from = function patchedFrom(table) {
      const q = originalFrom.call(this, table);
      if (table === 'deals' && !injected) {
        const originalMaybeSingle = q.maybeSingle.bind(q);
        q.maybeSingle = async () => {
          const result = await originalMaybeSingle();
          // No instante exato em que ESTA execução acabou de olhar e não
          // achou nada, uma requisição "concorrente" já grava o cartão —
          // exatamente a corrida que o índice único parcial (migration
          // 0018) e o catch de 23505 em ensurePipelineDeal existem pra cobrir.
          injected = true;
          db.tables.deals.push({ id: 'concurrent-winner', lead_id: leadId, product_id: null, etapa: 'lead' });
          return result;
        };
      }
      return q;
    };

    let res;
    try {
      res = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
    } finally {
      db.client.from = originalFrom;
    }

    expect(injected).toBe(true); // confirma que a corrida foi realmente forçada
    expect(res.status).toBe(200); // nunca 500 — o 23505 é absorvido, não propagado
    expect(db.tables.deals).toHaveLength(1); // nunca dois cartões pro mesmo lead
    expect(db.tables.deals[0].lead_id).toBe(leadId);
  });

  it('mantém a etapa atual e o responsável ao reparar apenas um cartão ausente', async () => {
    const body = csv('Alfa;11987654321;;;nao;', 'Beta;11988888888;;;nao;');
    const url = `/leads/import/commit?doctor_id=${doctorA}&nome_lista=Teste&filename=teste.csv`;
    expect((await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body)).status).toBe(200);
    const lead = db.tables.leads[0];
    lead.status_atual = 'reuniao_marcada';
    lead.sdr_responsavel_id = closer;
    db.tables.deals.splice(0, 1);
    const replay = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
    expect(replay.status).toBe(200);
    expect(db.tables.deals).toHaveLength(2);
    expect(db.tables.deals.find((d) => d.lead_id === lead.id)).toMatchObject({ etapa: 'reuniao_marcada', sdr_responsavel_id: closer });
  });

  describe('correção 4 — retry de falha parcial', () => {
    const url = `/leads/import/commit?doctor_id=${doctorA}&nome_lista=Lista&filename=x.csv`;
    const body = csv('A;11987654321;;;nao;', 'B;11988888888;;;nao;');

    it('falha no meio do lote: marca falhou, preserva a linha já concluída, e a retomada completa sem duplicar', async () => {
      db.failNextWrite('leads', 'insert', 1, 1); // deixa a linha 1 passar, quebra na linha 2
      const primeira = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
      expect(primeira.status).toBeGreaterThanOrEqual(500);
      const lote = db.tables.lead_imports[0];
      expect(lote.status).toBe('falhou');
      expect(db.tables.lead_import_rows.filter((r) => r.import_id === lote.id)).toHaveLength(1); // só a linha 1
      expect(db.tables.leads).toHaveLength(1);

      const retomada = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
      expect(retomada.status).toBe(200);
      expect(retomada.body.ja_processado).toBe(false);
      expect(retomada.body.criados).toBe(2);
      expect(db.tables.leads).toHaveLength(2); // linha 1 NÃO foi duplicada
      expect(db.tables.lead_import_rows.filter((r) => r.import_id === lote.id)).toHaveLength(2);
      expect(db.tables.deals).toHaveLength(2);
    });

    it('falha ao criar cartão e retoma sem repetir o lead ou criar dois cartões', async () => {
      db.failNextWrite('deals', 'insert');
      const failed = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(db.tables.leads).toHaveLength(1);
      expect(db.tables.deals).toHaveLength(0);
      expect(db.tables.lead_import_rows).toHaveLength(0);
      const resumed = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
      expect(resumed.status).toBe(200);
      expect(db.tables.leads).toHaveLength(2);
      expect(db.tables.deals).toHaveLength(2);
    });

    it('lote processando recente -> 409 import_in_progress (sem reprocessar)', async () => {
      db.tables.lead_imports.push({
        id: 'stuck', doctor_id: doctorA,
        file_hash: fileHashOf(body),
        nome_lista: 'X', filename: 'x.csv', status: 'processando',
        criado_em: new Date().toISOString(), total: 2, criados: 0, atualizados: 0, duplicados: 0, invalidos: 0,
      });
      const res = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('import_in_progress');
      expect(db.tables.leads).toHaveLength(0);
    });

    it('lote processando abandonado (>15min) -> retoma normalmente', async () => {
      db.tables.lead_imports.push({
        id: 'stale', doctor_id: doctorA,
        file_hash: fileHashOf(body),
        nome_lista: 'X', filename: 'x.csv', status: 'processando',
        criado_em: new Date(Date.now() - 16 * 60_000).toISOString(), total: 2, criados: 0, atualizados: 0, duplicados: 0, invalidos: 0,
      });
      const res = await request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body);
      expect(res.status).toBe(200);
      expect(res.body.criados).toBe(2);
      expect(db.tables.lead_imports).toHaveLength(1); // reaproveitou o lote 'stale', não criou outro
    });
  });

  describe('correção 5 — corrida concorrente', () => {
    it('duas requisições de commit idênticas e concorrentes: nunca 500, nunca duplica leads', async () => {
      const url = `/leads/import/commit?doctor_id=${doctorA}&nome_lista=Lista&filename=x.csv`;
      const body = csv('A;11987654321;;;nao;');
      const [r1, r2] = await Promise.all([
        request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body),
        request(app).post(url).set(auth('a')).set('Content-Type', 'text/csv').send(body),
      ]);
      for (const r of [r1, r2]) expect(r.status).toBeLessThan(500);
      expect(db.tables.leads.filter((l) => l.telefone_normalizado === '5511987654321')).toHaveLength(1);
      expect(db.tables.lead_imports).toHaveLength(1);
    });
  });

  it('GET imports é isolado por médico', async () => {
    db.tables.lead_imports.push({ id: 'ia', doctor_id: doctorA, nome_lista: 'A' }, { id: 'ib', doctor_id: doctorB, nome_lista: 'B' });
    const own = await request(app).get(`/leads/imports?doctor_id=${doctorA}`).set(auth('a'));
    expect(own.status).toBe(200); expect(own.body.map((x) => x.id)).toEqual(['ia']);
    expect((await request(app).get(`/leads/imports?doctor_id=${doctorB}`).set(auth('a'))).status).toBe(403);
  });

  it('campanha valida o médico do import e calcula elegíveis/bloqueados só do lote', async () => {
    const importA = '10000000-0000-4000-8000-000000000001';
    const importB = '10000000-0000-4000-8000-000000000002';
    db.tables.lead_imports.push({ id: importA, doctor_id: doctorA }, { id: importB, doctor_id: doctorB });
    db.tables.leads.push(
      { id: 'eligible', doctor_id: doctorA, status_atual: 'lead', telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado' },
      { id: 'blocked', doctor_id: doctorA, status_atual: 'lead', telefone_normalizado: '5511987654322', whatsapp_authorization_status: 'pendente' },
      { id: 'outside', doctor_id: doctorA, status_atual: 'lead', telefone_normalizado: '5511987654323', whatsapp_authorization_status: 'autorizado' },
    );
    db.tables.lead_import_rows.push(
      { import_id: importA, lead_id: 'eligible', status: 'criado' },
      { import_id: importA, lead_id: 'blocked', status: 'atualizado' },
    );
    // FASE 2 — import_id exige modo_envio='template'. Sem variáveis, pra
    // manter o teste focado em import/elegibilidade, não em templates.
    const templateId = '20000000-0000-4000-8000-000000000001';
    db.tables.whatsapp_templates = [{
      id: templateId, doctor_id: doctorA, meta_template_id: 'mt1', nome: 'confirmacao', idioma: 'pt_BR',
      categoria: 'UTILITY', status: 'APPROVED', body_text: 'Olá!', body_variable_count: 0,
      supported: true, active: true, last_synced_at: new Date().toISOString(),
    }];
    const rejected = await request(app).post('/campanhas').set(auth('a'))
      .send({ doctor_id: doctorA, nome: 'X', import_id: importB, modo_envio: 'template', whatsapp_template_id: templateId });
    expect(rejected.status).toBe(403);
    const created = await request(app).post('/campanhas').set(auth('a'))
      .send({ doctor_id: doctorA, nome: 'X', import_id: importA, modo_envio: 'template', whatsapp_template_id: templateId });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ import_id: importA, total_leads: 2, elegiveis: 1, bloqueados: 1 });
  });
});
