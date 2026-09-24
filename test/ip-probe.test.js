import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEchoApp } from '../scripts/ip-echo-server.mjs';
import { runProbe, summarize } from '../scripts/ip-probe.mjs';
import { analyzeBucket } from '../scripts/lib/ipProbeAnalysis.mjs';

// A ferramenta de prova é testada contra CADEIAS SIMULADAS. Isto valida a LÓGICA
// de decisão (o que ela recomenda em cada cenário) — não substitui rodar
// scripts/ip-probe.mjs num serviço de teste real da Render.
const CLIENT = '203.0.113.99';
const EDGES = ['172.71.0.11', '172.71.0.12', '172.71.0.13'];
const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve)))); });

const listen = (server) => new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server.address().port); }); });

// Proxy que imita: cliente -> borda Cloudflare -> balanceador Render -> eco.
// O "cliente real" é o valor de X-Probe-Expected-Ip (tudo é loopback no teste).
async function startChain(profile) {
  const echoPort = await listen(http.createServer(createEchoApp()));
  let counter = 0;
  const proxy = http.createServer((req, res) => {
    const headers = { ...req.headers };
    const client = headers['x-probe-expected-ip'];
    const edge = EDGES[counter % EDGES.length];
    counter += 1;
    const existingXff = headers['x-forwarded-for'];
    // Cloudflare: descarta o que o cliente mandou nestes headers e refaz.
    delete headers['cf-connecting-ip']; delete headers['true-client-ip']; delete headers['x-real-ip'];
    const forgedCf = req.headers['cf-connecting-ip'];
    if (profile === 'cloudflare') { headers['cf-connecting-ip'] = client; headers['cf-ray'] = `ray${counter}-GRU`; }
    // Caminho MEDIDO na Render: a borda bloqueia (403) quem manda CF-Connecting-IP;
    // o app recebe CF-Connecting-IP + True-Client-IP reais e uma cadeia de 3 entradas
    // (cliente, borda, hop interno da Render) — o cliente fica na posição 3.
    if (profile === 'render-real') {
      if (forgedCf) { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<!doctype html><title>blocked</title>'); return; }
      headers['cf-connecting-ip'] = client; headers['true-client-ip'] = client; headers['cf-ray'] = `ray${counter}-GRU`;
    }
    if (profile === 'leaky') { headers['cf-connecting-ip'] = forgedCf || client; headers['cf-ray'] = `ray${counter}-GRU`; }
    if (profile === 'flapping') { headers['cf-connecting-ip'] = client; if (counter % 2) headers['cf-ray'] = 'ray-GRU'; }
    // XFF: Cloudflare acrescenta o cliente; o balanceador da Render acrescenta a borda.
    const withClient = profile === 'edge-only' ? existingXff : [existingXff, client].filter(Boolean).join(', ');
    const internalHop = profile === 'render-real' ? `10.28.${counter % 7}.${(counter * 3) % 200}` : null;
    headers['x-forwarded-for'] = [withClient, edge, internalHop].filter(Boolean).join(', ');
    const upstream = http.request({ host: '127.0.0.1', port: echoPort, path: req.url, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode, up.headers); up.pipe(res);
    });
    upstream.end();
  });
  const port = await listen(proxy);
  return `http://127.0.0.1:${port}`;
}
const probe = async (profile) => {
  const baseUrl = await startChain(profile);
  const result = await runProbe({ baseUrl, expectedIp: CLIENT });
  return result;
};

describe('ip-probe contra cadeias simuladas', () => {
  it('cadeia fiel (Cloudflare sobrescreve o header; XFF = cliente, borda): defeito reproduzido e AMBAS as estratégias comprovadas; prefere o header', async () => {
    const { report } = await probe('cloudflare');
    expect(report.buckets.current.ok).toBe(false); // trust=1 vê a borda, que rotaciona
    expect(report.hops).toMatchObject({ consistent: true, position: 2, forgedXffSafe: true, usable: true });
    expect(report.cf).toMatchObject({ presentAlways: true, cfRayAlways: true, distinctFingerprints: 1, clientControllable: false, forgedIgnored: true, usable: true });
    expect(report.viable).toEqual({ cfHeader: true, trustProxyHops: true });
    expect(report.recommendation).toEqual({ mode: 'cf-header', TRUST_PROXY_HOPS: 1, TRUST_CLOUDFLARE_HEADERS: 'true' });
  });

  it('caminho real da Render (4 saltos; borda bloqueia CF-Connecting-IP forjado): header comprovado E saltos = 3 como plano B', async () => {
    const { report, observations } = await probe('render-real');
    expect(observations.forgedCf.every((row) => row.blockedAtEdge)).toBe(true);
    expect(report.cf).toMatchObject({ presentAlways: true, cfRayAlways: true, clientControllable: false, edgeBlocksForgedCf: true, usable: true });
    expect(report.hops).toMatchObject({ consistent: true, position: 3, forgedXffSafe: true, usable: true });
    expect(report.buckets.current.ok).toBe(false); // trust=1 cai no hop interno da Render
    expect(report.currentConfig).toEqual({ trustProxy: 1, choosesClient: false, defect: true });
    expect(report.buckets.cf.ok).toBe(true);
    expect(report.buckets.hops.ok).toBe(true);
    expect(report.recommendation).toEqual({ mode: 'cf-header', TRUST_PROXY_HOPS: 1, TRUST_CLOUDFLARE_HEADERS: 'true' });
    expect(report.reasons.join(' ')).toMatch(/A borda bloqueou/);
  });

  it('header vazando (o valor forjado chega ao app): CF-Connecting-IP é marcado como controlável e NÃO é recomendado', async () => {
    const { report } = await probe('leaky');
    expect(report.cf.clientControllable).toBe(true);
    expect(report.cf.usable).toBe(false);
    expect(report.viable.cfHeader).toBe(false);
    expect(report.reasons.join(' ')).toMatch(/cliente controla o header/);
    expect(report.recommendation.TRUST_CLOUDFLARE_HEADERS).toBe('false');
  });

  it('header ausente: cai para a contagem de saltos (que independe do header)', async () => {
    const { report } = await probe('no-cf-header');
    expect(report.cf.presentAlways).toBe(false);
    expect(report.cf.usable).toBe(false);
    expect(report.viable).toEqual({ cfHeader: false, trustProxyHops: true });
    expect(report.recommendation).toMatchObject({ mode: 'trust-proxy-hops', TRUST_PROXY_HOPS: 2 });
  });

  it('CF-Ray inconsistente: header não é usável (a defesa em profundidade da flag falharia)', async () => {
    const { report } = await probe('flapping');
    expect(report.cf.cfRayAlways).toBe(false);
    expect(report.cf.usable).toBe(false);
  });

  it('cadeia sem o IP do cliente (só a borda): nenhuma estratégia comprovada -> mantém a configuração atual', async () => {
    const { report } = await probe('edge-only');
    expect(report.hops.usable).toBe(false);
    expect(report.viable).toEqual({ cfHeader: false, trustProxyHops: false });
    expect(report.recommendation).toEqual({ mode: 'nenhuma-estrategia-comprovada', TRUST_PROXY_HOPS: 1, TRUST_CLOUDFLARE_HEADERS: 'false' });
  });

  it('PRIVACIDADE: nada do que a sonda devolve contém IP completo (só máscara, fingerprint e booleanos)', async () => {
    const { observations, report } = await probe('cloudflare');
    const text = JSON.stringify({ observations, summary: summarize(observations, report) });
    for (const fullIp of [CLIENT, '198.51.100.77', '198.51.100.78', ...EDGES, '127.0.0.1']) expect(text).not.toContain(fullIp);
    expect(text).toContain('203.0.x.x');
  });

  it('cada estratégia mede o balde do CLIENTE: sequência 1..n e requisições forjadas continuam no mesmo balde', async () => {
    const { observations } = await probe('cloudflare');
    for (const strategy of ['cf', 'trust-2']) {
      const sample = observations.buckets[strategy];
      expect(sample.normal.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect([...sample.forgedCf, ...sample.forgedXff, ...sample.after].map((r) => r.seq)).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
      expect(new Set([...sample.normal, ...sample.forgedCf, ...sample.forgedXff, ...sample.after].map((r) => r.key.fp)).size).toBe(1);
    }
    // a configuração atual (trust=1) enxerga bordas rotativas: várias chaves
    expect(new Set(observations.buckets['trust-1'].normal.map((r) => r.key.fp)).size).toBeGreaterThan(1);
  });
});

describe('configuração atual: sequência limpa numa rajada curta NÃO significa "sem defeito"', () => {
  it('trust=1 com balde estável, mas escolhendo um hop interno (não o cliente) = defeito', async () => {
    const { report, observations } = await probe('render-real');
    // força a rajada "limpa": mesma chave em todas as requisições do trust-1
    const stable = observations.buckets['trust-1'].normal.map((row, i) => ({ ...row, key: { fp: 'mesmo-hop', masked: '10.x.x.x' }, seq: i + 1 }));
    const patched = { ...observations, buckets: { ...observations.buckets, 'trust-1': { normal: stable, forgedCf: [], forgedXff: [], after: [] } } };
    const { analyzeProbe } = await import('../scripts/lib/ipProbeAnalysis.mjs');
    const result = analyzeProbe(patched);
    expect(result.buckets.current.ok).toBe(true);
    expect(result.currentConfig).toEqual({ trustProxy: 1, choosesClient: false, defect: true });
    expect(result.reasons.join(' ')).toMatch(/NÃO usa o IP do cliente/);
    expect(report.currentConfig.defect).toBe(true);
  });
});

describe('analyzeBucket', () => {
  const row = (fp, seq) => ({ key: { fp }, seq });
  it('sequência única com forjados no mesmo balde é saudável', () => {
    expect(analyzeBucket({ normal: [row('a', 1), row('a', 2), row('a', 3)], forgedCf: [row('a', 4)], forgedXff: [row('a', 5)], after: [row('a', 6)] }).ok).toBe(true);
  });
  it('2ª execução no mesmo serviço (contadores já em 11): sequência consecutiva continua saudável', () => {
    expect(analyzeBucket({ normal: [row('a', 11), row('a', 12), row('a', 13)], forgedCf: [row('a', 14)], forgedXff: [row('a', 15)], after: [row('a', 16)] }).ok).toBe(true);
  });
  it('salto na sequência (outra chave consumindo) = defeito', () => {
    expect(analyzeBucket({ normal: [row('a', 11), row('a', 13)] }).ok).toBe(false);
  });
  it('recomeço da contagem = chave variando = defeito', () => {
    expect(analyzeBucket({ normal: [row('a', 1), row('b', 1), row('a', 2)] }).ok).toBe(false);
  });
  it('valor forjado criando balde novo = defeito', () => {
    expect(analyzeBucket({ normal: [row('a', 1), row('a', 2)], forgedCf: [row('z', 1)] }).ok).toBe(false);
  });
  it('sem dados não é aprovado', () => {
    expect(analyzeBucket(undefined).ok).toBe(false);
    expect(analyzeBucket({ normal: [] }).ok).toBe(false);
  });
});
