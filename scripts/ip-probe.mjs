// Sonda de IP para o serviço de teste (ver scripts/ip-echo-server.mjs).
//   node scripts/ip-probe.mjs https://<servico-de-teste>.onrender.com
// Descobre o IP público desta máquina (api.ipify.org) só para comparar com o que
// chega ao servidor de eco; ele NUNCA é impresso — a saída só tem máscaras,
// booleanos e a recomendação.
import { analyzeProbe } from './lib/ipProbeAnalysis.mjs';

const FORGED_IP = '198.51.100.77'; // TEST-NET-2 (documentação): nunca é um cliente real
const NORMAL = 12;
const FORGED = 4;

export async function runProbe({ baseUrl, expectedIp, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/+$/, '');
  const base = { 'X-Probe-Expected-Ip': expectedIp, 'X-Probe-Forged-Ip': FORGED_IP };
  // O servidor de eco NUNCA responde 403. Um 403 vem da borda (Cloudflare bloqueia
  // a requisição que traz um CF-Connecting-IP forjado antes de chegar à Render):
  // isso é evidência de que o valor forjado não chega ao app, não uma falha da sonda.
  // Só é tolerado nas requisições FORJADAS (`tolerateEdgeBlock`).
  const get = async (path, extra = {}, tolerateEdgeBlock = false) => {
    const response = await fetchImpl(`${root}${path}`, { headers: { ...base, ...extra } });
    if (tolerateEdgeBlock && response.status === 403) return { blockedAtEdge: true };
    if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
    return response.json();
  };
  const sets = {
    forgedCf: { 'CF-Connecting-IP': FORGED_IP },
    forgedXff: { 'X-Forwarded-For': `${FORGED_IP}, 198.51.100.78` },
    forgedOthers: { 'True-Client-IP': FORGED_IP, 'X-Real-IP': FORGED_IP },
  };

  const echo = async (extra, n, tolerate = false) => { const rows = []; for (let i = 0; i < n; i += 1) rows.push(await get('/echo', extra, tolerate)); return rows; };
  const observations = {
    normal: await echo({}, NORMAL),
    forgedCf: await echo(sets.forgedCf, FORGED, true),
    forgedXff: await echo(sets.forgedXff, FORGED, true),
    forgedOthers: await echo(sets.forgedOthers, FORGED, true),
    buckets: {},
  };

  const bucket = async (strategy, extra) => get(`/bucket?strategy=${strategy}`, extra, Object.keys(extra).some((k) => k.toLowerCase() === 'cf-connecting-ip'));
  for (const strategy of ['cf', 'trust-1', 'trust-2', 'trust-3']) {
    const sample = { normal: [], forgedCf: [], forgedXff: [], after: [] };
    for (let i = 0; i < 10; i += 1) sample.normal.push(await bucket(strategy, {}));
    for (let i = 0; i < 3; i += 1) sample.forgedCf.push(await bucket(strategy, sets.forgedCf));
    for (let i = 0; i < 3; i += 1) sample.forgedXff.push(await bucket(strategy, sets.forgedXff));
    for (let i = 0; i < 2; i += 1) sample.after.push(await bucket(strategy, {}));
    observations.buckets[strategy] = sample;
  }
  return { observations, report: analyzeProbe(observations) };
}

export function summarize(observations, report) {
  const first = observations.normal[0];
  return {
    chegamAoApp: {
      xffEntradas: first.xffCount,
      posicaoDoCliente: report.hops.position,
      cfConnectingIpPresente: report.cf.presentAlways,
      cfRayPresente: report.cf.cfRayAlways,
      socketPeer: first.socketPeer.masked,
      ipEscolhidoPorTrust: Object.fromEntries(Object.entries(first.expressIpByTrust).map(([k, v]) => [k, v.masked])),
    },
    cfConnectingIp: report.cf,
    contagemPorSaltos: report.hops,
    baldes: report.buckets,
    configuracaoAtual: report.currentConfig,
    viavel: report.viable,
    recomendacao: report.recommendation,
    motivos: report.reasons,
  };
}

if (process.argv[1]?.endsWith('ip-probe.mjs')) {
  const [, , baseUrl, ...rest] = process.argv;
  if (!baseUrl) { process.stderr.write('uso: node scripts/ip-probe.mjs https://<servico-de-teste>.onrender.com\n'); process.exit(2); }
  const override = rest.find((arg) => arg.startsWith('--expected-ip='))?.split('=')[1];
  const expectedIp = override || (await (await fetch('https://api.ipify.org')).text()).trim();
  const { observations, report } = await runProbe({ baseUrl, expectedIp });
  process.stdout.write(`${JSON.stringify(summarize(observations, report), null, 2)}\n`);
}
