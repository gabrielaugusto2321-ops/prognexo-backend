import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
let db;
const captchaIps = [];
vi.mock('../src/lib/supabase.js', () => ({ get supabase() { return db.client; } }));
vi.mock('../src/lib/captcha.js', () => ({ verifyCaptcha: async (_token, ip) => { captchaIps.push(ip); return true; } }));
afterEach(() => { delete process.env.TRUST_CLOUDFLARE_HEADERS; delete process.env.TRUST_PROXY_HOPS; vi.resetModules(); });

// Aquece a árvore de imports pesada FORA do relógio do teste (padrão de team-api.test.js).
await import('../src/server.js');

async function app({ trustCf, hops } = {}) {
  vi.resetModules();
  if (trustCf === undefined) delete process.env.TRUST_CLOUDFLARE_HEADERS; else process.env.TRUST_CLOUDFLARE_HEADERS = trustCf;
  if (hops === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = String(hops);
  return (await import('../src/server.js')).createApp();
}

beforeEach(() => { db = makeDb({}); captchaIps.length = 0; });

const fakeReq = (headers) => ({ get: (name) => headers[name.toLowerCase()] });
const cf = (ip) => ({ 'CF-Connecting-IP': ip, 'CF-Ray': '8a1b2c3d4e5f-GRU' });
const remaining = async (api, headers) => Number((await request(api).get('/health').set(headers)).headers['ratelimit-remaining']);
const submitEmpty = (api, headers = {}) => request(api).post('/public/lead-forms/lf_AAAAAAAAAAAAAAAA/submit').set(headers).send({});

describe('resolveCloudflareClientIp', () => {
  it('flag desligada -> ignora o header (fora do Cloudflare qualquer cliente poderia forjá-lo)', async () => {
    const { resolveCloudflareClientIp } = await import('../src/middleware/clientIp.js');
    expect(resolveCloudflareClientIp(fakeReq({ 'cf-connecting-ip': '203.0.113.7', 'cf-ray': 'x' }), false)).toBeNull();
  });

  it('flag ligada mas SEM CF-Ray -> ignora (a requisição não provou ter passado pelo Cloudflare)', async () => {
    const { resolveCloudflareClientIp } = await import('../src/middleware/clientIp.js');
    expect(resolveCloudflareClientIp(fakeReq({ 'cf-connecting-ip': '203.0.113.7' }), true)).toBeNull();
  });

  it.each([['203.0.113.7', '203.0.113.7'], [' 203.0.113.7 ', '203.0.113.7'], ['2001:db8::1', '2001:db8::1']])('flag ligada + CF-Ray aceita IP válido (%s)', async (raw, expected) => {
    const { resolveCloudflareClientIp } = await import('../src/middleware/clientIp.js');
    expect(resolveCloudflareClientIp(fakeReq({ 'cf-connecting-ip': raw, 'cf-ray': 'x' }), true)).toBe(expected);
  });

  it.each([undefined, '', 'abc', '999.1.1.1', '203.0.113.7, 198.51.100.1', '203.0.113.7:443', '<script>'])('ignora valor inválido (%s)', async (raw) => {
    const { resolveCloudflareClientIp } = await import('../src/middleware/clientIp.js');
    expect(resolveCloudflareClientIp(fakeReq({ ...(raw === undefined ? {} : { 'cf-connecting-ip': raw }), 'cf-ray': 'x' }), true)).toBeNull();
  });
});

describe('modo header (TRUST_CLOUDFLARE_HEADERS=true): baldes por visitante real', () => {
  it('cada visitante tem o PRÓPRIO balde', async () => {
    const api = await app({ trustCf: 'true' });
    const statusesA = [];
    for (let i = 0; i < 11; i += 1) statusesA.push((await submitEmpty(api, cf('203.0.113.10'))).status);
    expect(statusesA.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statusesA[10]).toBe(429);
    expect((await submitEmpty(api, cf('203.0.113.20'))).status).toBe(400);
    expect((await submitEmpty(api, cf('203.0.113.10'))).status).toBe(429);
  });

  it('o contador de UM visitante decresce em sequência única (critério de aceite)', async () => {
    const api = await app({ trustCf: 'true' });
    const seen = [];
    for (let i = 0; i < 6; i += 1) seen.push(await remaining(api, cf('203.0.113.30')));
    expect(seen).toEqual([299, 298, 297, 296, 295, 294]);
  });

  it('IPv6 do mesmo visitante também é um balde só', async () => {
    const api = await app({ trustCf: 'true' });
    expect((await remaining(api, cf('2001:db8::1'))) - (await remaining(api, cf('2001:db8::1')))).toBe(1);
  });

  it('flag desligada (padrão): o header é ignorado e todos compartilham o IP da conexão', async () => {
    const api = await app();
    for (let i = 0; i < 10; i += 1) await submitEmpty(api, cf('203.0.113.10'));
    expect((await submitEmpty(api, cf('203.0.113.20'))).status).toBe(429);
  });

  it('header inválido cai no IP da conexão (nunca aceita valor forjado)', async () => {
    const api = await app({ trustCf: 'true' });
    for (let i = 0; i < 10; i += 1) await submitEmpty(api, { 'CF-Connecting-IP': 'lixo', 'CF-Ray': 'x' });
    expect((await submitEmpty(api, { 'CF-Connecting-IP': 'outro-lixo', 'CF-Ray': 'x' })).status).toBe(429);
  });

  it('X-Forwarded-For forjado não cria balde novo', async () => {
    const api = await app({ trustCf: 'true' });
    for (let i = 0; i < 10; i += 1) await submitEmpty(api, { ...cf('203.0.113.40'), 'X-Forwarded-For': `198.51.100.${i}` });
    expect((await submitEmpty(api, { ...cf('203.0.113.40'), 'X-Forwarded-For': '198.51.100.99' })).status).toBe(429);
  });
});

// Cadeia simulada do caminho medido na Render: cliente -> borda do Cloudflare ->
// balanceador da Render -> app. O app vê o socket do balanceador (loopback aqui) e
// X-Forwarded-For = "cliente, borda". É uma SIMULAÇÃO do que foi medido, não a
// prova do caminho real (essa vem do scripts/ip-probe.mjs num serviço de teste).
describe('modo saltos (TRUST_PROXY_HOPS) sobre a cadeia simulada [cliente, borda]', () => {
  const chain = (client, edge, forgedPrefix = '') => ({ 'X-Forwarded-For': `${forgedPrefix}${client}, ${edge}` });

  it('padrão (1 salto) REPRODUZ o defeito: visitantes diferentes na mesma borda dividem o balde', async () => {
    const api = await app();
    const a = await remaining(api, chain('203.0.113.10', '172.71.0.1'));
    const b = await remaining(api, chain('203.0.113.20', '172.71.0.1'));
    expect([a, b]).toEqual([299, 298]);
  });

  it('padrão (1 salto) REPRODUZ o defeito: o mesmo visitante via bordas diferentes é diluído em vários baldes', async () => {
    const api = await app();
    const seen = [];
    for (const edge of ['172.71.0.1', '172.71.0.2', '172.71.0.1', '172.71.0.3']) seen.push(await remaining(api, chain('203.0.113.10', edge)));
    expect(seen).toEqual([299, 299, 298, 299]);
  });

  it('2 saltos: cada visitante tem o próprio balde, mesmo na mesma borda', async () => {
    const api = await app({ hops: 2 });
    const a = await remaining(api, chain('203.0.113.10', '172.71.0.1'));
    const b = await remaining(api, chain('203.0.113.20', '172.71.0.1'));
    expect([a, b]).toEqual([299, 299]);
  });

  it('2 saltos: o mesmo visitante via bordas diferentes é UM balde só (sequência única)', async () => {
    const api = await app({ hops: 2 });
    const seen = [];
    for (const edge of ['172.71.0.1', '172.71.0.2', '172.71.0.1', '172.71.0.3']) seen.push(await remaining(api, chain('203.0.113.10', edge)));
    expect(seen).toEqual([299, 298, 297, 296]);
  });

  it('2 saltos: prefixo forjado no X-Forwarded-For NÃO cria balde novo (fica à esquerda do cliente)', async () => {
    const api = await app({ hops: 2 });
    const seen = [];
    for (const forged of ['', '198.51.100.1, ', '198.51.100.2, 198.51.100.3, ', '198.51.100.4, ']) seen.push(await remaining(api, chain('203.0.113.10', '172.71.0.1', forged)));
    expect(seen).toEqual([299, 298, 297, 296]);
  });

  it('2 saltos: com CF-Connecting-IP forjado no meio, a contagem por saltos ignora o header', async () => {
    const api = await app({ hops: 2 });
    const seen = [];
    for (const forged of ['198.51.100.5', '198.51.100.6', '198.51.100.7']) seen.push(await remaining(api, { ...chain('203.0.113.10', '172.71.0.1'), 'CF-Connecting-IP': forged, 'CF-Ray': 'x' }));
    expect(seen).toEqual([299, 298, 297]);
  });

  it('salto a mais do que a cadeia tem não quebra (cai no que existe)', async () => {
    const api = await app({ hops: 3 });
    const response = await request(api).get('/health').set({ 'X-Forwarded-For': '172.71.0.1' });
    expect(response.status).toBe(200);
  });

  it('TRUST_PROXY_HOPS inválido derruba a configuração (não vira um valor perigoso em silêncio)', async () => {
    vi.resetModules();
    process.env.TRUST_PROXY_HOPS = '99';
    await expect(import('../src/server.js')).rejects.toThrow(/Invalid environment configuration/);
    process.env.TRUST_PROXY_HOPS = 'abc';
    vi.resetModules();
    await expect(import('../src/server.js')).rejects.toThrow(/Invalid environment configuration/);
  });
});

describe('o IP real chega a quem depende dele', () => {
  const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const seed = () => {
    db = makeDb({
      doctors: [{ id: U(11), owner_user_id: U(1), nome: 'A', distribuicao_automatica: false }],
      lead_capture_forms: [{ id: U(101), public_id: 'lf_AAAAAAAAAAAAAAAA', doctor_id: U(11), organization_id: null, name: 'F', allowed_origins: ['https://a.test'], pipeline_stage: 'lead', redirect_url: null, success_message: null, consent_version: 1, active: true }],
      lead_capture_form_consent_versions: [{ id: 'cv', form_id: U(101), version: 1, consent_text: 'Aceito receber mensagens.' }],
    });
  };
  const submit = async (api, headers) => {
    const { createLeadFormToken } = await import('../src/lib/leadFormToken.js');
    return request(api).post('/public/lead-forms/lf_AAAAAAAAAAAAAAAA/submit').set(headers).send({
      nome: 'Maria', email: 'm@example.com', telefone: '(11) 99999-0001', consent: false,
      embed_token: createLeadFormToken({ pid: 'lf_AAAAAAAAAAAAAAAA', host: 'https://a.test', now: Date.now() - 5000 }),
    });
  };
  const hash = (ip) => createHash('sha256').update(`${ip}:lf_AAAAAAAAAAAAAAAA`).digest('hex');

  it('modo header: CAPTCHA (remoteip) e hash de IP da captação usam o visitante, não a borda', async () => {
    seed();
    const response = await submit(await app({ trustCf: 'true' }), cf('203.0.113.50'));
    expect(response.status).toBe(200);
    expect(captchaIps).toEqual(['203.0.113.50']);
    expect(db.tables.lead_capture_submissions[0].ip_hash).toBe(hash('203.0.113.50'));
  });

  it('modo saltos (2): idem, a partir da cadeia X-Forwarded-For', async () => {
    seed();
    const response = await submit(await app({ hops: 2 }), { 'X-Forwarded-For': '203.0.113.60, 172.71.0.9' });
    expect(response.status).toBe(200);
    expect(captchaIps).toEqual(['203.0.113.60']);
    expect(db.tables.lead_capture_submissions[0].ip_hash).toBe(hash('203.0.113.60'));
  });
});
