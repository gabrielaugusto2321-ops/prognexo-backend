// Servidor de DIAGNÓSTICO de IP — não faz parte da API do Prognexo.
//
// Serve para descobrir, num serviço de teste da Render (mesma entrada:
// Cloudflare -> balanceador da Render -> app), QUAIS valores chegam ao Express
// e qual IP cada estratégia escolheria. Suba como um Web Service separado, com
//   start command: node scripts/ip-echo-server.mjs
// e rode `node scripts/ip-probe.mjs https://<servico>.onrender.com`.
//
// Privacidade: nunca registra nem devolve um IP completo. Cada endereço sai como
// máscara (ex.: 177.118.x.x) + impressão digital (sha256 com sal aleatório do
// processo, 10 hex) — dá para comparar "é o mesmo IP?" sem revelar o IP. Não há
// log de requisição. Sem autenticação e sem dados de negócio: derrube o serviço
// depois do teste.
import crypto from 'node:crypto';
import express from 'express';
import proxyaddr from 'proxy-addr';

const SALT = crypto.randomBytes(16);
export const fingerprint = (ip) => crypto.createHmac('sha256', SALT).update(String(ip)).digest('hex').slice(0, 10);

export function maskIp(ip) {
  if (!ip) return null;
  const value = String(ip).replace(/^::ffff:/, '');
  if (value.includes(':')) return `${value.split(':').slice(0, 2).join(':')}:…`;
  const parts = value.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : 'invalido';
}
const describeIp = (ip) => (ip ? { masked: maskIp(ip), fp: fingerprint(String(ip).replace(/^::ffff:/, '')) } : null);
const clean = (ip) => (ip ? String(ip).replace(/^::ffff:/, '').trim() : null);

function header(req, name) {
  const value = req.headers[name];
  return typeof value === 'string' ? value : null;
}

// Cadeia como o Express a enxerga: [socket, XFF da direita para a esquerda...].
export function chainOf(req) {
  const socket = clean(req.socket.remoteAddress);
  const xff = (header(req, 'x-forwarded-for') || '').split(',').map((v) => v.trim()).filter(Boolean).reverse();
  return { socket, xff };
}

// IP que o Express escolheria com `trust proxy = n` (mesma regra do app.set numérico).
export const ipWithTrust = (req, hops) => clean(proxyaddr(req, (_addr, index) => index < hops));

export function buildEcho(req) {
  const { socket, xff } = chainOf(req);
  // Valores que o próprio teste informa para virar "confere / não confere" —
  // nunca são devolvidos nem registrados.
  const expected = clean(header(req, 'x-probe-expected-ip'));
  const forged = clean(header(req, 'x-probe-forged-ip'));
  const flag = (ip) => ({ matchesExpected: expected ? clean(ip) === expected : null, matchesForged: forged ? clean(ip) === forged : null });
  const single = (name) => {
    const value = header(req, name);
    return value === null ? { present: false } : { present: true, list: value.includes(','), ...describeIp(clean(value)), ...flag(value) };
  };
  return {
    socketPeer: { ...describeIp(socket), ...flag(socket) },
    xffCount: xff.length,
    xffFromRight: xff.map((ip, i) => ({ position: i + 1, ...describeIp(ip), ...flag(ip) })),
    headers: {
      cfConnectingIp: single('cf-connecting-ip'),
      trueClientIp: single('true-client-ip'),
      xRealIp: single('x-real-ip'),
      cfRay: header(req, 'cf-ray') !== null,
      forwarded: header(req, 'forwarded') !== null,
    },
    expressIpByTrust: Object.fromEntries([0, 1, 2, 3, 4].map((hops) => {
      const ip = ipWithTrust(req, hops);
      return [`trust${hops}`, { ...describeIp(ip), ...flag(ip) }];
    })),
  };
}

// Estratégias candidatas para chave de rate limit.
const STRATEGIES = {
  cf: (req) => clean(header(req, 'cf-connecting-ip')),
  'trust-1': (req) => ipWithTrust(req, 1),
  'trust-2': (req) => ipWithTrust(req, 2),
  'trust-3': (req) => ipWithTrust(req, 3),
  'xff-leftmost': (req) => (header(req, 'x-forwarded-for') || '').split(',')[0]?.trim() || null,
};

export function createEchoApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false); // lê tudo cru; cada estratégia decide sozinha
  const counters = Object.fromEntries(Object.keys(STRATEGIES).map((name) => [name, new Map()]));

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/echo', (req, res) => res.set('Cache-Control', 'no-store').json(buildEcho(req)));

  // Simula um balde de rate limit por estratégia: devolve a posição da requisição
  // DENTRO do balde da chave escolhida. Sequência 1,2,3… = balde único; saltos
  // ou recomeços = a chave varia (limite diluído / compartilhado).
  app.get('/bucket', (req, res) => {
    const strategy = STRATEGIES[req.query.strategy];
    if (!strategy) return res.status(400).json({ error: 'strategy invalida', valid: Object.keys(STRATEGIES) });
    const key = strategy(req);
    if (!key) return res.json({ strategy: req.query.strategy, key: null, seq: null });
    const map = counters[req.query.strategy];
    const seq = (map.get(key) || 0) + 1;
    map.set(key, seq);
    return res.set('Cache-Control', 'no-store').json({ strategy: req.query.strategy, key: describeIp(key), seq, distinctKeys: map.size });
  });
  return app;
}

if (process.argv[1]?.endsWith('ip-echo-server.mjs')) {
  const port = Number(process.env.PORT) || 3000;
  createEchoApp().listen(port, () => process.stdout.write(`ip-echo-server ouvindo na porta ${port}\n`));
}
