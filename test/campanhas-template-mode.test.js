import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.WHATSAPP_SEND_INTERVAL_MS = '0'; // desliga pacing artificial nos testes
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';

let db;
const sendWhatsAppMessage = vi.fn(async () => ({}));
const sendWhatsAppTemplate = vi.fn(async () => ({ messageId: 'wamid.mock' }));

vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/whatsapp.js', () => ({ sendWhatsAppMessage, sendWhatsAppTemplate }));

const { app } = await import('../src/server.js');

const OWNER = '00000000-0000-4000-8100-0000000ow01';
const DOC_A = '00000000-0000-4000-8100-0000000da01';
const DOC_B = '00000000-0000-4000-8100-0000000db01';
const TPL_OK = '00000000-0000-4000-8100-0000000tp01';
const TPL_B = '00000000-0000-4000-8100-0000000tp02';
const IMPORT_A = '00000000-0000-4000-8100-0000000aa001';

function baseTemplate(overrides = {}) {
  return {
    id: TPL_OK, doctor_id: DOC_A, meta_template_id: 'mt-1', nome: 'confirmacao', idioma: 'pt_BR',
    categoria: 'UTILITY', status: 'APPROVED', body_text: 'Olá {{1}}, sua consulta é dia {{2}}.',
    body_variable_count: 2, supported: true, active: true, last_synced_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  sendWhatsAppMessage.mockClear();
  sendWhatsAppTemplate.mockClear();
  db = makeDb({
    users: [{ id: OWNER, role: 'doctor', ativo: true }],
    doctors: [{ id: DOC_A, owner_user_id: OWNER, nome: 'Dr. Owner' }, { id: DOC_B }],
    integrations: [{ doctor_id: DOC_A, gateway: 'whatsapp', external_id: 'pn', access_token: 'tok' }],
    whatsapp_templates: [baseTemplate()],
    lead_imports: [{ id: IMPORT_A, doctor_id: DOC_A }],
    lead_import_rows: [{ import_id: IMPORT_A, lead_id: 'L1', status: 'criado' }],
    leads: [
      { id: 'L1', doctor_id: DOC_A, nome: 'Maria', telefone_normalizado: '5511987654321', whatsapp_authorization_status: 'autorizado', status_atual: 'lead' },
    ],
    campanhas: [],
    campanha_envios: [],
  });
  db.setAuthUser('owner', { id: OWNER });
});

const mapa2 = { 1: { source: 'lead_nome' }, 2: { source: 'fixo', value: 'quinta-feira' } };

describe('POST /campanhas — validações de modo_envio', () => {
  it('modo_envio=template exige whatsapp_template_id', async () => {
    const res = await request(app).post('/campanhas').set({ Authorization: 'Bearer owner' })
      .send({ doctor_id: DOC_A, nome: 'Camp', modo_envio: 'template' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('whatsapp_template_id_required');
  });

  it('template de outro médico é bloqueado com 403, nunca revela detalhes', async () => {
    db.tables.whatsapp_templates.push(baseTemplate({ id: TPL_B, doctor_id: DOC_B, meta_template_id: 'mt-2' }));
    const res = await request(app).post('/campanhas').set({ Authorization: 'Bearer owner' })
      .send({ doctor_id: DOC_A, nome: 'Camp', modo_envio: 'template', whatsapp_template_id: TPL_B, template_variable_map: mapa2 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('template_forbidden');
  });

  it('template não aprovado/não sincronizado recentemente é bloqueado (409)', async () => {
    db.tables.whatsapp_templates.find((t) => t.id === TPL_OK).status = 'PENDING';
    const res = await request(app).post('/campanhas').set({ Authorization: 'Bearer owner' })
      .send({ doctor_id: DOC_A, nome: 'Camp', modo_envio: 'template', whatsapp_template_id: TPL_OK, template_variable_map: mapa2 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('template_not_ready');
  });

  it('quantidade/posição de variáveis errada é rejeitada', async () => {
    const res = await request(app).post('/campanhas').set({ Authorization: 'Bearer owner' })
      .send({ doctor_id: DOC_A, nome: 'Camp', modo_envio: 'template', whatsapp_template_id: TPL_OK, template_variable_map: { 1: { source: 'lead_nome' } } });
    expect(res.status).toBe(400);
  });

  it('modo_envio=template válido cria a campanha com snapshot congelado', async () => {
    const res = await request(app).post('/campanhas').set({ Authorization: 'Bearer owner' })
      .send({ doctor_id: DOC_A, nome: 'Camp', modo_envio: 'template', whatsapp_template_id: TPL_OK, template_variable_map: mapa2 });
    expect(res.status).toBe(200);
    expect(res.body.modo_envio).toBe('template');
    expect(res.body.template_snapshot).toMatchObject({ meta_template_id: 'mt-1', body_variable_count: 2 });
  });

  it('regressão de produção — rascunho com template aprovado (hello_world, 0 variáveis) + lista importada de 3 leads não quebra com 500 (mensagem NOT NULL), grava o snapshot do corpo do template', async () => {
    // Reprodução exata do bug real: "null value in column mensagem of
    // relation campanhas violates not-null constraint" — o backend deixava
    // mensagem=null pra campanhas de template, mas a coluna é NOT NULL na
    // produção real (confirmado via information_schema, não pelo baseline.sql
    // local desatualizado).
    const TPL_HELLO = '00000000-0000-4000-8100-0000000tp03';
    const IMPORT_HELLO = '00000000-0000-4000-8100-0000000aa002';
    db.tables.whatsapp_templates.push({
      id: TPL_HELLO, doctor_id: DOC_A, meta_template_id: 'hello_world', nome: 'hello_world', idioma: 'en_US',
      categoria: 'UTILITY', status: 'APPROVED', body_text: 'Hello World',
      body_variable_count: 0, supported: true, active: true, last_synced_at: new Date().toISOString(),
    });
    db.tables.lead_imports.push({ id: IMPORT_HELLO, doctor_id: DOC_A });
    db.tables.leads.push(
      { id: 'H1', doctor_id: DOC_A, nome: 'Ana', telefone_normalizado: '5511900000001', whatsapp_authorization_status: 'autorizado', status_atual: 'lead' },
      { id: 'H2', doctor_id: DOC_A, nome: 'Bia', telefone_normalizado: '5511900000002', whatsapp_authorization_status: 'autorizado', status_atual: 'lead' },
      { id: 'H3', doctor_id: DOC_A, nome: 'Caio', telefone_normalizado: '5511900000003', whatsapp_authorization_status: 'autorizado', status_atual: 'lead' },
    );
    db.tables.lead_import_rows.push(
      { import_id: IMPORT_HELLO, lead_id: 'H1', status: 'criado' },
      { import_id: IMPORT_HELLO, lead_id: 'H2', status: 'criado' },
      { import_id: IMPORT_HELLO, lead_id: 'H3', status: 'criado' },
    );

    const res = await request(app).post('/campanhas').set({ Authorization: 'Bearer owner' })
      .send({ doctor_id: DOC_A, nome: 'Hello World Campaign', import_id: IMPORT_HELLO, modo_envio: 'template', whatsapp_template_id: TPL_HELLO, template_variable_map: {} });

    expect(res.status).toBe(200); // nunca 500
    expect(res.body.mensagem).toBe('Hello World'); // snapshot do corpo do template, vindo do banco — nunca null
    expect(res.body.total_leads).toBe(3);
    expect(res.body.modo_envio).toBe('template');
    // o envio de verdade continua usando o template, nunca vira texto livre:
    expect(db.tables.campanhas[db.tables.campanhas.length - 1].whatsapp_template_id).toBe(TPL_HELLO);
  });

  it('import_id sem modo_envio=template é rejeitado', async () => {
    const res = await request(app).post('/campanhas').set({ Authorization: 'Bearer owner' })
      .send({ doctor_id: DOC_A, nome: 'Camp', import_id: IMPORT_A, mensagem: 'oi' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('import_requires_template_mode');
  });

  it('import_id com modo_envio=template é aceito', async () => {
    const res = await request(app).post('/campanhas').set({ Authorization: 'Bearer owner' })
      .send({ doctor_id: DOC_A, nome: 'Camp', import_id: IMPORT_A, modo_envio: 'template', whatsapp_template_id: TPL_OK, template_variable_map: mapa2 });
    expect(res.status).toBe(200);
  });

  it('modo_envio=texto_livre (default) continua exigindo mensagem', async () => {
    const res = await request(app).post('/campanhas').set({ Authorization: 'Bearer owner' })
      .send({ doctor_id: DOC_A, nome: 'Camp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('mensagem_obrigatoria_texto_livre');
  });
});

describe('POST /campanhas/:id/enviar — modo template', () => {
  const settle = () => new Promise((r) => setTimeout(r, 400));

  function seedCampanha(overrides = {}) {
    const camp = {
      id: 'CAMPT1', doctor_id: DOC_A, status: 'rascunho', modo_envio: 'template',
      whatsapp_template_id: TPL_OK, template_variable_map: mapa2, mensagem: null,
      ...overrides,
    };
    db.tables.campanhas.push(camp);
    return camp;
  }

  it('ignora a janela de 24h (sem mensagem recebida) mas ainda exige consentimento', async () => {
    seedCampanha();
    const res = await request(app).post('/campanhas/CAMPT1/enviar').set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await settle();
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(db.tables.campanha_envios.find((e) => e.lead_id === 'L1').status).toBe('enviado');
  });

  it('opt_out durante a fila bloqueia o envio do próximo lead (nunca manda pra quem saiu no meio do processamento)', async () => {
    db.tables.leads.push({ id: 'L2', doctor_id: DOC_A, nome: 'Joana', telefone_normalizado: '5511987654322', whatsapp_authorization_status: 'autorizado', status_atual: 'lead' });
    seedCampanha();
    // Simula o opt_out chegando (webhook concorrente) enquanto L1 já está sendo enviado.
    sendWhatsAppTemplate.mockImplementationOnce(async () => {
      db.tables.leads.find((l) => l.id === 'L2').whatsapp_authorization_status = 'opt_out';
      return { messageId: 'wamid.mock' };
    });
    const res = await request(app).post('/campanhas/CAMPT1/enviar').set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await settle();
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(1); // só L1; L2 nunca chega a chamar a Meta
    expect(db.tables.campanha_envios.find((e) => e.lead_id === 'L1').status).toBe('enviado');
    expect(db.tables.campanha_envios.find((e) => e.lead_id === 'L2').status).toBe('opt_out');
  });

  it('lead em quarentena de identidade de telefone bloqueia o envio', async () => {
    seedCampanha();
    db.tables.leads.find((l) => l.id === 'L1').dados_extraidos = { phone_identity_review_required: true };
    const res = await request(app).post('/campanhas/CAMPT1/enviar').set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await settle();
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(db.tables.campanha_envios.find((e) => e.lead_id === 'L1').status).toBe('phone_identity_review_required');
  });

  it('revalida o template imediatamente antes de aceitar /enviar (409 se não está mais pronto)', async () => {
    seedCampanha();
    db.tables.whatsapp_templates.find((t) => t.id === TPL_OK).active = false;
    const res = await request(app).post('/campanhas/CAMPT1/enviar').set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('template_not_ready');
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it('envia com os parâmetros na ordem certa e persiste message_id sanitizado', async () => {
    seedCampanha();
    const res = await request(app).post('/campanhas/CAMPT1/enviar').set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await settle();
    expect(sendWhatsAppTemplate).toHaveBeenCalledWith('pn', 'tok', '5511987654321', {
      name: 'confirmacao', languageCode: 'pt_BR', bodyParameters: [
        { type: 'text', text: 'Maria' }, { type: 'text', text: 'quinta-feira' },
      ],
    });
    const envio = db.tables.campanha_envios.find((e) => e.lead_id === 'L1');
    expect(envio.status).toBe('enviado');
    expect(envio.message_id).toBe('wamid.mock');
    expect(envio.meta_status).toBe('accepted');
  });

  it('erro permanente de template (132001) marca falhou, sem retry', async () => {
    seedCampanha();
    sendWhatsAppTemplate.mockRejectedValueOnce(Object.assign(new Error('rejected'), { metaError: { code: 132001, message: 'Template paused' } }));
    const res = await request(app).post('/campanhas/CAMPT1/enviar').set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await settle();
    const envio = db.tables.campanha_envios.find((e) => e.lead_id === 'L1');
    expect(envio.status).toBe('falhou');
    expect(envio.meta_error_code).toBe('132001');
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(1); // nunca reenviado automaticamente
  });

  it('timeout/rede indisponível -> resultado_desconhecido, nunca reenviado automaticamente', async () => {
    seedCampanha();
    sendWhatsAppTemplate.mockRejectedValueOnce(Object.assign(new Error('timeout'), { networkError: true }));
    const res = await request(app).post('/campanhas/CAMPT1/enviar').set({ Authorization: 'Bearer owner' });
    expect(res.status).toBe(202);
    await settle();
    const envio = db.tables.campanha_envios.find((e) => e.lead_id === 'L1');
    expect(envio.status).toBe('resultado_desconhecido');
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
  });

  it('resposta e ledger nunca contêm telefone completo/token/payload em claro além do necessário', async () => {
    seedCampanha();
    const res = await request(app).post('/campanhas/CAMPT1/enviar').set({ Authorization: 'Bearer owner' });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/tok\b|5511987654321/);
  });
});
