import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';
import { createLeadFormToken, verifyLeadFormToken } from '../src/lib/leadFormToken.js';
import { countCampaignSendableRecipients } from '../src/lib/campaignRecipients.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
process.env.FRONTEND_URL = 'https://painel.test';

let db;
let captchaOk = true;
const captchaCalls = [];
const pickCloser = vi.fn(async () => null);
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/captcha.js', () => ({ verifyCaptcha: async (...args) => { captchaCalls.push(args); return captchaOk; } }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: (...args) => pickCloser(...args) }));
afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

// Aquece a árvore de imports pesada FORA do relógio do teste (sob a carga da
// suíte completa o 1º import do servidor estoura os 30s). Padrão de team-api.test.js.
await import('../src/server.js');

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D_A = U(11); const D_B = U(12); const ORG_A = U(21); const ORG_B = U(22);
const PID_A = 'lf_AAAAAAAAAAAAAAAA'; const PID_A2 = 'lf_A2A2A2A2A2A2A2A2'; const PID_B = 'lf_BBBBBBBBBBBBBBBB'; const PID_OFF = 'lf_CCCCCCCCCCCCCCCC';
const HOST_A = 'https://a.test'; const HOST_B = 'https://b.test'; const PREVIEW = 'https://painel.test';
const UNIFORM = { ok: true, message: 'Obrigado A', redirect_url: 'https://a.test/ebook.pdf' };

async function app() {
  vi.resetModules();
  return (await import('../src/server.js')).createApp();
}

function form(over) {
  return {
    id: over.id, public_id: over.public_id, doctor_id: over.doctor_id, organization_id: over.organization_id, name: over.name ?? 'Formulário',
    allowed_origins: over.allowed_origins, pipeline_stage: over.pipeline_stage ?? 'lead', redirect_url: over.redirect_url ?? null,
    success_message: over.success_message ?? null, consent_version: 1, active: over.active ?? true, criado_em: new Date().toISOString(),
  };
}

beforeEach(() => {
  captchaOk = true; captchaCalls.length = 0; pickCloser.mockReset(); pickCloser.mockResolvedValue(null);
  db = makeDb({
    doctors: [{ id: D_A, owner_user_id: U(1), nome: 'A', distribuicao_automatica: false }, { id: D_B, owner_user_id: U(2), nome: 'B', distribuicao_automatica: false }],
    lead_capture_forms: [
      form({ id: U(101), public_id: PID_A, doctor_id: D_A, organization_id: ORG_A, name: 'Ebook A', allowed_origins: [HOST_A, 'https://www.a.test'], pipeline_stage: 'conversa_iniciada', redirect_url: 'https://a.test/ebook.pdf', success_message: 'Obrigado A' }),
      form({ id: U(102), public_id: PID_A2, doctor_id: D_A, organization_id: ORG_A, name: 'Outro A', allowed_origins: [HOST_A], pipeline_stage: 'lead', redirect_url: 'https://a.test/ebook.pdf', success_message: 'Obrigado A' }),
      form({ id: U(103), public_id: PID_B, doctor_id: D_B, organization_id: ORG_B, name: 'Ebook B', allowed_origins: [HOST_B] }),
      form({ id: U(104), public_id: PID_OFF, doctor_id: D_A, organization_id: ORG_A, name: 'Inativo', allowed_origins: [HOST_A], active: false }),
    ],
    lead_capture_form_consent_versions: [
      { id: 'cv1', form_id: U(101), version: 1, consent_text: 'Aceito receber WhatsApp da Clínica A.' },
      { id: 'cv2', form_id: U(102), version: 1, consent_text: 'Aceito receber WhatsApp (form 2).' },
      { id: 'cv3', form_id: U(103), version: 1, consent_text: 'Aceito receber WhatsApp da Clínica B.' },
      { id: 'cv4', form_id: U(104), version: 1, consent_text: 'Inativo.' },
    ],
  });
});

const tokenFor = (pid, host, ageMs = 5000) => createLeadFormToken({ pid, host, now: Date.now() - ageMs });

async function submit(api, pid, over = {}, { host = HOST_A, ageMs = 5000, token, headers = {} } = {}) {
  return request(api).post(`/public/lead-forms/${pid}/submit`).set(headers).send({
    nome: 'Maria Silva', email: 'Maria@Example.com', telefone: '(11) 99999-0001', consent: false,
    embed_token: token ?? tokenFor(pid, host, ageMs), utm: { utm_source: 'instagram', utm_campaign: 'ebook' }, ...over,
  });
}
const leads = () => db.tables.leads || [];
const deals = () => db.tables.deals || [];
const proofs = () => db.tables.lead_capture_submissions || [];
const noWrites = () => { expect(leads()).toHaveLength(0); expect(deals()).toHaveLength(0); expect(proofs()).toHaveLength(0); };

describe('embed: validação de domínio no servidor', () => {
  it('domínio permitido -> 200, CSP frame-ancestors exato, sem X-Frame-Options, sem cache', async () => {
    const response = await request(await app()).get(`/public/lead-forms/${PID_A}/embed`).set('Referer', `${HOST_A}/pagina/x?y=1`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    const csp = response.headers['content-security-policy'];
    expect(csp).toContain(`frame-ancestors ${HOST_A} https://www.a.test ${PREVIEW}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('challenges.cloudflare.com');
    expect(response.headers['x-frame-options']).toBeUndefined();
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sem Referer, Referer de outro site ou lixo -> 403 sem detalhes do formulário', async () => {
    const api = await app();
    for (const referer of [undefined, 'https://evil.test/p', 'nao-e-url', 'https://a.test.evil.test/', 'http://a.test/']) {
      const req = request(api).get(`/public/lead-forms/${PID_A}/embed`);
      const response = await (referer ? req.set('Referer', referer) : req);
      expect(response.status, String(referer)).toBe(403);
      expect(response.text).not.toContain('Ebook A');
      expect(response.text).not.toContain(PID_A);
    }
  });

  it('formulário inativo ou inexistente -> 404 (mesmo com Referer válido)', async () => {
    const api = await app();
    expect((await request(api).get(`/public/lead-forms/${PID_OFF}/embed`).set('Referer', HOST_A)).status).toBe(404);
    expect((await request(api).get('/public/lead-forms/lf_ZZZZZZZZZZZZZZZZ/embed').set('Referer', HOST_A)).status).toBe(404);
  });

  it('página: checkbox NÃO vem marcado, honeypot presente, nenhum id/segredo interno vaza', async () => {
    const response = await request(await app()).get(`/public/lead-forms/${PID_A}/embed`).set('Referer', HOST_A);
    expect(response.text).toContain('Aceito receber WhatsApp da Clínica A.');
    expect(response.text).not.toMatch(/name="consent"[^>]*checked/);
    expect(response.text).toContain('name="website"');
    for (const secret of [D_A, ORG_A, U(101), 'SUPABASE', 'service_role', 'doctor_id', 'organization_id']) expect(response.text).not.toContain(secret);
  });

  it('token embutido é assinado para ESTE formulário e ESTE domínio; UTMs só as conhecidas e truncadas', async () => {
    const response = await request(await app())
      .get(`/public/lead-forms/${PID_A}/embed?utm_source=ig&utm_campaign=${'x'.repeat(300)}&foo=bar&doctor_id=x&utm_term=<script>`)
      .set('Referer', `${HOST_A}/lp`);
    const config = JSON.parse(response.text.match(/const cfg=(\{.*?\});\n/s)[1].replace(/\\u003c/g, '<'));
    const payload = verifyLeadFormToken(config.token, { pid: PID_A });
    expect(payload).toMatchObject({ pid: PID_A, host: HOST_A });
    expect(verifyLeadFormToken(config.token, { pid: PID_B })).toBeNull();
    expect(config.utm.utm_source).toBe('ig');
    expect(config.utm.utm_campaign).toHaveLength(120);
    expect(Object.keys(config.utm).sort()).toEqual(['utm_campaign', 'utm_source', 'utm_term']);
    expect(response.text).not.toContain('<script>"');
  });

  it('prévia do painel (FRONTEND_URL) pode emoldurar mesmo fora da lista, com aviso de que não grava', async () => {
    const response = await request(await app()).get(`/public/lead-forms/${PID_A}/embed`).set('Referer', `${PREVIEW}/`);
    expect(response.status).toBe(200);
    expect(response.text).toContain('Pré-visualização');
  });
});

describe('envio: identificadores e tenant NUNCA vêm do cliente', () => {
  it.each(['doctor_id', 'organization_id', 'form_id', 'lead_id', 'status', 'whatsapp_authorization_status', 'public_id'])('campo %s no corpo -> 400 e nada é gravado', async (key) => {
    const response = await submit(await app(), PID_A, { [key]: key.endsWith('_id') ? D_B : 'autorizado' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_payload' });
    noWrites();
  });

  it('utm com chave desconhecida -> 400', async () => {
    expect((await submit(await app(), PID_A, { utm: { utm_source: 'x', doctor_id: D_B } })).status).toBe(400);
    noWrites();
  });

  it('token de OUTRO formulário no caminho deste -> 403 domain_not_allowed', async () => {
    const response = await submit(await app(), PID_A, {}, { token: tokenFor(PID_B, HOST_B) });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'domain_not_allowed' });
    noWrites();
  });

  it('o lead sempre nasce no médico/organização DO FORMULÁRIO', async () => {
    const api = await app();
    expect((await submit(api, PID_A)).status).toBe(200);
    expect((await submit(api, PID_B, { telefone: '(21) 98888-0002' }, { host: HOST_B })).status).toBe(200);
    const a = leads().find((l) => l.telefone_normalizado === '5511999990001');
    const b = leads().find((l) => l.telefone_normalizado === '5521988880002');
    expect([a.doctor_id, a.organization_id]).toEqual([D_A, ORG_A]);
    expect([b.doctor_id, b.organization_id]).toEqual([D_B, ORG_B]);
  });

  it('resposta nunca expõe ids, estado do lead ou motivo interno', async () => {
    const response = await submit(await app(), PID_A);
    expect(Object.keys(response.body).sort()).toEqual(['message', 'ok', 'redirect_url']);
    expect(JSON.stringify(response.body)).not.toMatch(/lead_id|doctor|organization|autoriz|opt_out|outcome|created|updated/i);
  });
});

describe('envio: domínio, token e anti-abuso', () => {
  it.each([
    ['token de host fora da lista', () => ({ token: tokenFor(PID_A, 'https://evil.test') })],
    ['token adulterado', () => ({ token: `${tokenFor(PID_A, HOST_A)}x` })],
    ['token expirado (>30 min)', () => ({ ageMs: 31 * 60 * 1000 })],
    ['token sem assinatura', () => ({ token: 'abc.def' })],
  ])('%s -> 403', async (_label, options) => {
    const response = await submit(await app(), PID_A, {}, options());
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'domain_not_allowed' });
    noWrites();
  });

  it('sem embed_token -> 400', async () => {
    const response = await request(await app()).post(`/public/lead-forms/${PID_A}/submit`).send({ nome: 'Maria', email: 'm@x.com', telefone: '11999990001' });
    expect(response.status).toBe(400);
    noWrites();
  });

  it('domínio removido da lista DEPOIS de o token ser emitido -> 403', async () => {
    const api = await app();
    const token = tokenFor(PID_A, HOST_A);
    db.tables.lead_capture_forms.find((f) => f.public_id === PID_A).allowed_origins = ['https://outro.test'];
    expect((await submit(api, PID_A, {}, { token })).status).toBe(403);
    noWrites();
  });

  it('formulário desativado depois do embed -> 404', async () => {
    const api = await app();
    const token = tokenFor(PID_A, HOST_A);
    db.tables.lead_capture_forms.find((f) => f.public_id === PID_A).active = false;
    expect((await submit(api, PID_A, {}, { token })).status).toBe(404);
    expect((await submit(api, PID_OFF)).status).toBe(404);
    noWrites();
  });

  it('rápido demais (token emitido há <2s) -> 400 too_fast', async () => {
    const response = await submit(await app(), PID_A, {}, { ageMs: 0 });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'too_fast' });
    noWrites();
  });

  it('honeypot preenchido -> MESMA resposta de sucesso, nada gravado, captcha nem consultado', async () => {
    const real = await submit(await app(), PID_A, { telefone: '(11) 99999-0009' });
    db.tables.leads = []; db.tables.deals = []; db.tables.lead_capture_submissions = []; captchaCalls.length = 0;
    const bot = await submit(await app(), PID_A, { website: 'http://spam.example' });
    expect(bot.status).toBe(200);
    expect(bot.body).toEqual(real.body);
    expect(captchaCalls).toHaveLength(0);
    noWrites();
  });

  it('CAPTCHA reprovado -> 403 captcha_required e nada gravado; o token do cliente é repassado ao verificador', async () => {
    captchaOk = false;
    const response = await submit(await app(), PID_A, { captcha_token: 'tok-cliente' });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'captcha_required' });
    expect(captchaCalls[0][0]).toBe('tok-cliente');
    noWrites();
  });

  it.each([
    ['telefone curto demais', { telefone: '123' }, 'invalid_payload'],
    ['DDD inexistente', { telefone: '(00) 99999-0001' }, 'invalid_phone'],
    ['número estrangeiro', { telefone: '+1 415 555 2671' }, 'invalid_phone'],
    ['assinante inválido', { telefone: '(11) 09999-0001' }, 'invalid_phone'],
  ])('%s -> 400', async (_label, over, error) => {
    const response = await submit(await app(), PID_A, over);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(error);
    noWrites();
  });

  it.each([['e-mail inválido', { email: 'nao-e-email' }], ['nome vazio', { nome: ' ' }], ['consent não booleano', { consent: 'on' }]])('%s -> 400', async (_label, over) => {
    expect((await submit(await app(), PID_A, over)).status).toBe(400);
    noWrites();
  });

  it('rate limit por IP: a 11ª requisição no minuto -> 429', async () => {
    const api = await app();
    const statuses = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await request(api).post(`/public/lead-forms/${PID_A}/submit`).send({})).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('rate limit do embed: 61ª carga no minuto -> 429', async () => {
    const api = await app();
    let last;
    for (let i = 0; i < 61; i += 1) last = await request(api).get(`/public/lead-forms/${PID_A}/embed`).set('Referer', HOST_A);
    expect(last.status).toBe(429);
  }, 60_000);

  it('prévia do painel valida tudo mas NÃO cria lead', async () => {
    const response = await submit(await app(), PID_A, {}, { host: PREVIEW });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(UNIFORM);
    noWrites();
    expect((await submit(await app(), PID_A, { telefone: '123' }, { host: PREVIEW })).status).toBe(400);
  });

  it('CORS: rotas públicas não devolvem CORS e aceitam o POST same-origin do iframe; o resto da API segue restrito', async () => {
    const api = await app();
    const own = await submit(api, PID_A, {}, { headers: { Origin: 'https://prognexo-backend.test' } });
    expect(own.status).toBe(200);
    expect(own.headers['access-control-allow-origin']).toBeUndefined();
    expect((await request(api).get('/health').set('Origin', 'https://evil.test')).status).toBe(403);
    expect((await request(api).get('/doctors').set('Origin', 'https://evil.test')).status).toBe(403);
    expect((await request(api).get('/health').set('Origin', 'https://app.test')).status).toBe(200);
    expect((await request(api).get('/health')).status).toBe(200);
  });
});

describe('consentimento e prova', () => {
  it('SEM aceite: lead pendente, e-book entregue, sem data/fonte de autorização, prova registrada', async () => {
    const response = await submit(await app(), PID_A, { consent: false });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(UNIFORM);
    const lead = leads()[0];
    expect(lead.whatsapp_authorization_status).toBe('pendente');
    expect(lead.whatsapp_authorization_at).toBeNull();
    expect(lead.whatsapp_authorization_source).toBeNull();
    expect(proofs()).toEqual([expect.objectContaining({ consent_given: false, consent_applied: false, consented_at: null, consent_version: 1, outcome: 'created', page_origin: HOST_A })]);
  });

  it('COM aceite: autorizado, com texto, versão, data e fonte na prova', async () => {
    const response = await submit(await app(), PID_A, { consent: true });
    expect(response.body).toEqual(UNIFORM);
    const lead = leads()[0];
    expect(lead.whatsapp_authorization_status).toBe('autorizado');
    expect(lead.whatsapp_authorization_source).toBe(`lead_form:${PID_A}`);
    expect(Number.isNaN(Date.parse(lead.whatsapp_authorization_at))).toBe(false);
    expect(proofs()[0]).toMatchObject({
      consent_given: true, consent_applied: true, consent_version: 1, consent_text_snapshot: 'Aceito receber WhatsApp da Clínica A.', page_origin: HOST_A,
    });
    expect(Number.isNaN(Date.parse(proofs()[0].consented_at))).toBe(false);
  });

  it('a prova guarda o texto da versão VIGENTE no envio, mesmo que o texto mude depois', async () => {
    const api = await app();
    await submit(api, PID_A, { consent: true });
    db.tables.lead_capture_forms.find((f) => f.public_id === PID_A).consent_version = 2;
    db.tables.lead_capture_form_consent_versions.push({ id: 'cv9', form_id: U(101), version: 2, consent_text: 'Texto NOVO v2' });
    await submit(api, PID_A, { consent: true, telefone: '(11) 99999-0003' });
    expect(proofs().map((p) => [p.consent_version, p.consent_text_snapshot])).toEqual([[1, 'Aceito receber WhatsApp da Clínica A.'], [2, 'Texto NOVO v2']]);
  });

  it('GATE DE CAMPANHA: só o lead que aceitou é elegível; quem não aceitou fica fora', async () => {
    const api = await app();
    await submit(api, PID_A, { consent: false, telefone: '(11) 99999-0001' });
    const campanha = { doctor_id: D_A, import_id: null, filtro_status: null };
    expect(await countCampaignSendableRecipients(db.client, campanha)).toBe(0);
    await submit(api, PID_A, { consent: true, telefone: '(11) 99999-0002' });
    expect(await countCampaignSendableRecipients(db.client, campanha)).toBe(1);
    expect(await countCampaignSendableRecipients(db.client, { ...campanha, doctor_id: D_B })).toBe(0);
  });

  it.each(['opt_out', 'recusado'])('lead com %s prévio NUNCA vira autorizado, mesmo marcando o aceite; resposta idêntica', async (status) => {
    const api = await app();
    const fresh = await submit(api, PID_A, { consent: true, telefone: '(11) 99999-0077' });
    db.tables.leads.push({ id: 'legacy-1', doctor_id: D_A, nome: 'Contato', telefone: '11999990004', telefone_normalizado: '5511999990004', whatsapp_authorization_status: status, status_atual: 'lead' });
    const blocked = await submit(api, PID_A, { consent: true, telefone: '(11) 99999-0004' });
    expect(blocked.status).toBe(200);
    expect(blocked.body).toEqual(fresh.body);
    const lead = leads().find((l) => l.id === 'legacy-1');
    expect(lead.whatsapp_authorization_status).toBe(status);
    expect(lead.whatsapp_authorization_at ?? null).toBeNull();
    expect(proofs().find((p) => p.lead_id === 'legacy-1')).toMatchObject({ consent_given: true, consent_applied: false, consent_block_reason: `previous_${status}` });
    expect(await countCampaignSendableRecipients(db.client, { doctor_id: D_A, import_id: null, filtro_status: null })).toBe(1);
  });

  it('autorizado + envio SEM aceite não rebaixa; pendente + aceite posterior promove', async () => {
    const api = await app();
    await submit(api, PID_A, { consent: true });
    await submit(api, PID_A, { consent: false });
    expect(leads()[0].whatsapp_authorization_status).toBe('autorizado');
    await submit(api, PID_A, { consent: false, telefone: '(11) 99999-0005' });
    expect(leads().find((l) => l.telefone_normalizado === '5511999990005').whatsapp_authorization_status).toBe('pendente');
    await submit(api, PID_A, { consent: true, telefone: '11 99999-0005' });
    expect(leads().find((l) => l.telefone_normalizado === '5511999990005').whatsapp_authorization_status).toBe('autorizado');
  });

  it('captação NÃO dispara nenhuma mensagem, job ou requisição externa', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await submit(await app(), PID_A, { consent: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const table of ['job_queue', 'outbox_events', 'conversations', 'usage_ledger', 'campanha_envios', 'campanhas']) expect(db.tables[table] || []).toHaveLength(0);
  });
});

describe('funil, origem e duplicidade', () => {
  it('lead novo entra na etapa do formulário, com origem/UTMs e e-mail normalizado', async () => {
    await submit(await app(), PID_A);
    expect(leads()).toHaveLength(1);
    expect(leads()[0]).toMatchObject({
      doctor_id: D_A, status_atual: 'conversa_iniciada', origem: 'formulario_captacao', origem_lead: 'Ebook A',
      utm_source: 'instagram', utm_campaign: 'ebook', email: 'maria@example.com', telefone_normalizado: '5511999990001',
    });
    expect(deals()).toEqual([expect.objectContaining({ lead_id: leads()[0].id, etapa: 'conversa_iniciada' })]);
  });

  it('mesmo contato em formatos diferentes e em formulários diferentes do tenant = 1 lead e 1 deal', async () => {
    const api = await app();
    for (const telefone of ['(11) 99999-0001', '11999990001', '+55 11 99999-0001', '5511999990001']) expect((await submit(api, PID_A, { telefone })).status).toBe(200);
    expect((await submit(api, PID_A2, { telefone: '11 99999 0001' })).status).toBe(200);
    expect(leads()).toHaveLength(1);
    expect(deals()).toHaveLength(1);
  });

  it('reenvio preserva o primeiro toque: e-mail e UTM originais não são sobrescritos', async () => {
    const api = await app();
    await submit(api, PID_A, { email: 'primeiro@x.com', utm: { utm_source: 'google' } });
    await submit(api, PID_A, { email: 'segundo@x.com', utm: { utm_source: 'tiktok', utm_campaign: 'nova' } });
    expect(leads()).toHaveLength(1);
    expect(leads()[0]).toMatchObject({ email: 'primeiro@x.com', utm_source: 'google', utm_campaign: 'nova' });
    expect(leads()[0].sdr_responsavel_id ?? null).toBeNull();
  });

  it('lead legado sem telefone_normalizado é encontrado pelo telefone bruto (não duplica) e ganha o normalizado', async () => {
    db.tables.leads = [{ id: 'old', doctor_id: D_A, nome: 'Antigo', telefone: '(11) 99999-0001', telefone_normalizado: null, whatsapp_authorization_status: 'pendente', status_atual: 'proposta' }];
    await submit(await app(), PID_A);
    expect(leads()).toHaveLength(1);
    expect(leads()[0]).toMatchObject({ id: 'old', telefone_normalizado: '5511999990001', nome: 'Antigo' });
    expect(deals()).toEqual([expect.objectContaining({ lead_id: 'old', etapa: 'proposta' })]);
  });

  it('lead que já tem cartão (mesmo de produto) não ganha um segundo', async () => {
    db.tables.leads = [{ id: 'old', doctor_id: D_A, nome: 'Antigo', telefone: '11999990001', telefone_normalizado: '5511999990001', whatsapp_authorization_status: 'pendente', status_atual: 'lead' }];
    db.tables.deals = [{ id: 'd-prod', lead_id: 'old', product_id: 'prod-1', etapa: 'lead' }];
    await submit(await app(), PID_A);
    expect(deals()).toHaveLength(1);
  });

  it('ISOLAMENTO: o mesmo telefone em outro médico vira OUTRO lead; o original não muda de tenant nem de estado', async () => {
    const api = await app();
    await submit(api, PID_A, { consent: true });
    const original = { ...leads()[0] };
    await submit(api, PID_B, { consent: false, email: 'b@x.com' }, { host: HOST_B });
    expect(leads()).toHaveLength(2);
    expect(leads().find((l) => l.id === original.id)).toMatchObject({ doctor_id: D_A, organization_id: ORG_A, whatsapp_authorization_status: 'autorizado', email: 'maria@example.com' });
    expect(leads().find((l) => l.id !== original.id)).toMatchObject({ doctor_id: D_B, organization_id: ORG_B, whatsapp_authorization_status: 'pendente', email: 'b@x.com' });
    expect(deals()).toHaveLength(2);
  });

  it('CONCORRÊNCIA: 8 envios idênticos simultâneos = 1 lead e 1 deal (o lock real é provado no Postgres)', async () => {
    const api = await app();
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(api, PID_A, { consent: true })));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(leads()).toHaveLength(1);
    expect(deals()).toHaveLength(1);
    expect(leads()[0].whatsapp_authorization_status).toBe('autorizado');
  });

  it('SPAM: o 5º envio do mesmo contato em 10 min é contido (throttled) e não altera nada', async () => {
    const api = await app();
    for (let i = 0; i < 5; i += 1) expect((await submit(api, PID_A, { consent: i === 4 })).status).toBe(200);
    expect(leads()).toHaveLength(1);
    expect(proofs().map((p) => p.outcome)).toEqual(['created', 'unchanged', 'unchanged', 'unchanged', 'throttled']);
    expect(leads()[0].whatsapp_authorization_status).toBe('pendente');
  });
});

describe('atribuição e falhas', () => {
  it('lead NOVO recebe o closer da distribuição automática (lead e deal); reenvio não reatribui', async () => {
    pickCloser.mockResolvedValue('closer-1');
    const api = await app();
    await submit(api, PID_A);
    await submit(api, PID_A);
    expect(leads()[0].sdr_responsavel_id).toBe('closer-1');
    expect(deals()[0].sdr_responsavel_id).toBe('closer-1');
    expect(pickCloser).toHaveBeenCalledTimes(1);
    expect(pickCloser).toHaveBeenCalledWith(D_A);
  });

  it('falha na distribuição NÃO derruba a captura', async () => {
    pickCloser.mockRejectedValue(new Error('boom'));
    const response = await submit(await app(), PID_A);
    expect(response.status).toBe(200);
    expect(leads()).toHaveLength(1);
  });

  it('erro do banco -> 500 genérico, sem vazar detalhe interno', async () => {
    const api = await app();
    db.client.rpc.mockResolvedValueOnce({ data: null, error: { message: 'connection refused 10.0.0.5:5432' } });
    const response = await submit(api, PID_A);
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toMatch(/connection|10\.0\.0\.5/);
  });
});
