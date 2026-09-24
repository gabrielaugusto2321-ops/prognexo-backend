import express from 'express';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

// Router montado sozinho, com env controlável: permite simular produção sem
// subir o servidor inteiro (que exige dezenas de variáveis de produção).
const envState = {};
let db;
vi.mock('../src/config/env.js', () => ({ env: envState }));
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/distribuicao.js', () => ({ escolherCloserAutomatico: async () => null }));
vi.mock('../src/middleware/rateLimits.js', () => {
  const pass = (_req, _res, next) => next();
  return { leadFormEmbedLimiter: pass, leadFormIpMinuteLimiter: pass, leadFormIpHourlyLimiter: pass, leadFormPublicIdLimiter: pass };
});
const { createLeadFormToken } = await import('../src/lib/leadFormToken.js');
const router = (await import('../src/routes/publicLeadForms.js')).default;
const api = express().use(express.json()).use('/public/lead-forms', router);

const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PID = 'lf_AAAAAAAAAAAAAAAA';
const HOST = 'https://a.test';
const SECRET = 'SEGREDO-TURNSTILE-NUNCA-VAZA';
const SITE_KEY = '0x4AAAAAAA-chave-publica';

function setEnv(values) {
  for (const key of Object.keys(envState)) delete envState[key];
  Object.assign(envState, {
    SUPABASE_SERVICE_ROLE_KEY: 'test-key', FRONTEND_URL: 'https://painel.test', NODE_ENV: 'development', ...values,
  });
}
const PROD_READY = { NODE_ENV: 'production', CAPTCHA_ENABLED: 'true', CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SECRET: SECRET, CAPTCHA_SITE_KEY: SITE_KEY };

function seed(redirect = 'https://a.test/ebook.pdf') {
  db = makeDb({
    doctors: [{ id: U(11), owner_user_id: U(1), nome: 'A', distribuicao_automatica: false }],
    lead_capture_forms: [{
      id: U(101), public_id: PID, doctor_id: U(11), organization_id: U(21), name: 'Ebook A', allowed_origins: [HOST], pipeline_stage: 'lead',
      redirect_url: redirect, success_message: null, consent_version: 1, active: true,
    }],
    lead_capture_form_consent_versions: [{ id: 'cv', form_id: U(101), version: 1, consent_text: 'Aceito receber mensagens.' }],
  });
}
const embed = () => request(api).get(`/public/lead-forms/${PID}/embed`).set('Referer', HOST);
const submit = (over = {}) => request(api).post(`/public/lead-forms/${PID}/submit`).send({
  nome: 'Maria Silva', email: 'm@example.com', telefone: '(11) 99999-0001', consent: false,
  embed_token: createLeadFormToken({ pid: PID, host: HOST, now: Date.now() - 5000 }), ...over,
});
const leads = () => db.tables.leads || [];

beforeEach(() => { setEnv({}); seed(); });
afterEach(() => vi.restoreAllMocks());

describe('prontidão do CAPTCHA (Turnstile) no embed', () => {
  it.each([
    ['produção com CAPTCHA desligado', { NODE_ENV: 'production', CAPTCHA_ENABLED: 'false' }],
    ['produção sem CAPTCHA_SITE_KEY (o widget nem renderizaria)', { ...PROD_READY, CAPTCHA_SITE_KEY: undefined }],
    ['produção sem CAPTCHA_SECRET', { ...PROD_READY, CAPTCHA_SECRET: undefined }],
    ['produção com provedor não suportado', { ...PROD_READY, CAPTCHA_PROVIDER: 'hcaptcha' }],
    ['CAPTCHA ligado fora de produção, mas sem site key', { ...PROD_READY, NODE_ENV: 'development', CAPTCHA_SITE_KEY: undefined }],
  ])('%s -> 503 "indisponível" (nunca um formulário que jamais funciona)', async (_label, values) => {
    setEnv(values);
    const response = await embed();
    expect(response.status).toBe(503);
    expect(response.text).toContain('temporariamente indisponível');
    expect(response.text).not.toContain('name="nome"');
    expect(response.text).not.toContain(PID);
    expect(response.text).not.toContain(SECRET);
  });

  it('produção completa -> widget com a chave PÚBLICA, CSP libera só o Turnstile, segredo nunca aparece', async () => {
    setEnv(PROD_READY);
    const response = await embed();
    expect(response.status).toBe(200);
    expect(response.text).toContain(`data-sitekey="${SITE_KEY}"`);
    expect(response.text).toMatch(/<script nonce="[^"]+" src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js"/);
    expect(response.headers['content-security-policy']).toMatch(/script-src 'nonce-[^']+' https:\/\/challenges\.cloudflare\.com/);
    expect(response.headers['content-security-policy']).toContain('frame-src https://challenges.cloudflare.com');
    expect(response.text).not.toContain(SECRET);
  });

  it('desenvolvimento com CAPTCHA desligado -> formulário normal, sem widget', async () => {
    const response = await embed();
    expect(response.status).toBe(200);
    expect(response.text).not.toContain('data-sitekey');
    expect(response.text).not.toContain('turnstile/v0/api.js');
    expect(response.headers['content-security-policy']).not.toContain('challenges.cloudflare.com');
  });
});

describe('validação do token do CAPTCHA no backend', () => {
  it('produção com CAPTCHA desligado: o envio direto (sem passar pelo embed) também é recusado, sem gravar', async () => {
    setEnv({ NODE_ENV: 'production', CAPTCHA_ENABLED: 'false' });
    const response = await submit();
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'captcha_required' });
    expect(leads()).toHaveLength(0);
  });

  it('token válido: consulta o siteverify da Cloudflare com secret + token + IP, e aceita o envio', async () => {
    setEnv(PROD_READY);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const response = await submit({ captcha_token: 'token-do-widget' });
    expect(response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init.method).toBe('POST');
    const sent = new URLSearchParams(init.body.toString());
    expect(sent.get('secret')).toBe(SECRET);
    expect(sent.get('response')).toBe('token-do-widget');
    expect(sent.get('remoteip')).toBeTruthy();
    expect(leads()).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
  });

  it.each([
    ['Cloudflare rejeita o token', () => ({ ok: true, json: async () => ({ success: false }) })],
    ['Cloudflare responde erro HTTP', () => ({ ok: false, json: async () => ({ success: true }) })],
  ])('%s -> 403 e nada gravado', async (_label, reply) => {
    setEnv(PROD_READY);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply());
    const response = await submit({ captcha_token: 'x' });
    expect(response.status).toBe(403);
    expect(leads()).toHaveLength(0);
  });

  it('Cloudflare fora do ar (fetch falha) -> fail-closed: 403, nunca aceita sem verificar', async () => {
    setEnv(PROD_READY);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    const response = await submit({ captcha_token: 'x' });
    expect(response.status).toBe(403);
    expect(leads()).toHaveLength(0);
  });

  it('sem token do widget -> 403 sem sequer consultar a Cloudflare', async () => {
    setEnv(PROD_READY);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await submit();
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('redirect de entrega: URLs perigosas nunca chegam ao visitante', () => {
  it.each([
    ['javascript:', 'javascript:alert(document.domain)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['http:', 'http://a.test/ebook.pdf'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['relativa', '/ebook.pdf'],
    ['lixo', 'nao-e-url'],
  ])('linha adulterada direto no banco (%s) -> resposta sem redirect e página sem link', async (_label, dangerous) => {
    seed(dangerous);
    const submitted = await submit();
    expect(submitted.status).toBe(200);
    expect(submitted.body.redirect_url).toBeNull();
    const page = await embed();
    expect(page.text).toContain('"redirectUrl":null');
    expect(page.text).not.toContain(dangerous.replace(/</g, '\\u003c'));
    expect(page.text).not.toContain('alert(');
  });

  it('https válido passa; sem consentimento o material é entregue igual', async () => {
    const semAceite = await submit({ consent: false });
    const comAceite = await submit({ consent: true, telefone: '(11) 99999-0002' });
    expect(semAceite.body.redirect_url).toBe('https://a.test/ebook.pdf');
    expect(comAceite.body).toEqual(semAceite.body);
    expect(leads().map((l) => l.whatsapp_authorization_status).sort()).toEqual(['autorizado', 'pendente']);
  });

  it('sem redirect configurado -> null (e o formulário funciona)', async () => {
    seed(null);
    const response = await submit();
    expect(response.status).toBe(200);
    expect(response.body.redirect_url).toBeNull();
  });
});
