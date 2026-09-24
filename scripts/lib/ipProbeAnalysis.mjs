// Análise PURA das observações do ip-probe. Sem rede, sem IP completo: trabalha só
// com os booleanos (matchesExpected / matchesForged) e impressões digitais que o
// servidor de eco devolve.
//
// Entradas (todas listas de respostas de GET /echo):
//   normal            requisições sem nenhum header forjado
//   forgedCf          com CF-Connecting-IP forjado
//   forgedXff         com X-Forwarded-For forjado (prefixo falso à esquerda)
//   forgedOthers      com True-Client-IP / X-Real-IP forjados
//   buckets           { [estrategia]: { normal: [{fp,seq}], forgedCf: [...], forgedXff: [...], after: [...] } }
const uniq = (values) => new Set(values).size;

export function clientPosition(echo) {
  if (echo.socketPeer?.matchesExpected) return 0;
  const hit = (echo.xffFromRight || []).find((entry) => entry.matchesExpected === true);
  return hit ? hit.position : null;
}

// Requisição forjada bloqueada na borda (403 do Cloudflare) nunca chegou ao app:
// conta como evidência de segurança e não entra nas comparações de valores.
const delivered = (rows = []) => rows.filter((row) => !row.blockedAtEdge);

export function analyzeCf({ normal, forgedCf: forgedCfAll }) {
  const cf = (echo) => echo.headers.cfConnectingIp;
  const forgedCf = delivered(forgedCfAll);
  const edgeBlocksForgedCf = forgedCfAll.length > 0 && forgedCf.length === 0;
  const presentAlways = normal.length > 0 && normal.every((e) => cf(e).present && !cf(e).list);
  const cfRayAlways = normal.length > 0 && normal.every((e) => e.headers.cfRay === true);
  const distinctFingerprints = uniq(normal.map((e) => cf(e).fp));
  const matchesRealClient = normal.length > 0 && normal.every((e) => cf(e).matchesExpected === true);
  // O valor forjado chegou ao app dentro do header de confiança? Então o cliente o controla.
  const clientControllable = forgedCf.some((e) => cf(e).matchesForged === true);
  // Ou o valor forjado foi ignorado (o header seguiu sendo o IP real) ou a borda bloqueou tudo.
  const forgedIgnored = forgedCfAll.length > 0 && forgedCf.every((e) => cf(e).matchesExpected === true);
  return {
    presentAlways, cfRayAlways, distinctFingerprints, matchesRealClient, clientControllable, forgedIgnored, edgeBlocksForgedCf,
    usable: presentAlways && cfRayAlways && distinctFingerprints === 1 && matchesRealClient && !clientControllable && forgedIgnored,
  };
}

export function analyzeHops({ normal, forgedXff: forgedXffAll, forgedCf: forgedCfAll = [], forgedOthers: forgedOthersAll = [] }) {
  const forgedXff = delivered(forgedXffAll);
  const forgedCf = delivered(forgedCfAll);
  const forgedOthers = delivered(forgedOthersAll);
  const positions = normal.map(clientPosition);
  const consistent = positions.length > 0 && positions.every((p) => p !== null && p === positions[0]);
  const position = consistent ? positions[0] : null;
  const trustKey = position === null ? null : `trust${position}`;
  const chosenIsClient = (echo) => trustKey !== null && echo.expressIpByTrust?.[trustKey]?.matchesExpected === true;
  // Prefixo forjado no XFF precisa ficar À ESQUERDA do cliente e não mudar a posição dele.
  const forgedXffSafe = forgedXffAll.length > 0 && position !== null && forgedXff.every((e) =>
    clientPosition(e) === position
    && (e.xffFromRight || []).filter((entry) => entry.matchesForged === true).every((entry) => entry.position > position)
    && chosenIsClient(e));
  const otherHeadersIrrelevant = [...forgedCf, ...forgedOthers].every(chosenIsClient);
  const clientIsSocketPeer = position === 0;
  return {
    consistent, position, forgedXffSafe, otherHeadersIrrelevant,
    usable: consistent && position >= 1 && position <= 4 && forgedXffSafe && otherHeadersIrrelevant && normal.every(chosenIsClient),
  };
}

// Um balde saudável: a sequência dos requests normais é 1,2,3…, com UMA chave só;
// requests forjados caem na MESMA chave e continuam a contagem.
export function analyzeBucket(sample) {
  if (!sample) return { ok: false, reason: 'sem dados' };
  const normal = sample.normal || [];
  // Relativa à primeira leitura: o servidor de eco guarda contadores em memória,
  // então uma 2ª execução da sonda no mesmo serviço não começa em 1.
  const seqs = normal.map((r) => r.seq);
  const start = seqs[0];
  const singleSequence = seqs.length > 0 && Number.isInteger(start) && seqs.every((seq, i) => seq === start + i);
  const keyFp = normal[0]?.key?.fp ?? null;
  const normalKeys = uniq(normal.map((r) => r.key?.fp));
  const forgedRows = delivered([...(sample.forgedCf || []), ...(sample.forgedXff || [])]);
  const forgedSameKey = forgedRows.every((r) => r.key?.fp === keyFp);
  const forgedContinues = [...normal, ...forgedRows, ...(sample.after || [])].every((r, i) => r.seq === start + i);
  return { ok: singleSequence && normalKeys === 1 && forgedSameKey && forgedContinues, singleSequence, normalKeys, forgedSameKey, forgedContinues };
}

export function analyzeProbe(observations) {
  const cf = analyzeCf(observations);
  const hops = analyzeHops(observations);
  const buckets = observations.buckets || {};
  const cfBucket = analyzeBucket(buckets.cf);
  const hopsBucket = hops.position >= 1 && hops.position <= 3 ? analyzeBucket(buckets[`trust-${hops.position}`]) : { ok: false, reason: 'posição fora de 1..3' };
  const currentConfig = analyzeBucket(buckets['trust-1']);

  const reasons = [];
  // Uma sequência única numa rajada curta NÃO basta: o que importa é a chave ser o
  // CLIENTE. Se for um hop interno/da borda, todos os visitantes compartilham a
  // mesma chave (e ela pode mudar com o tempo), mesmo que uma rajada pareça limpa.
  const currentChoosesClient = observations.normal.length > 0 && observations.normal.every((e) => e.expressIpByTrust?.trust1?.matchesExpected === true);
  const currentDefect = !currentConfig.ok || !currentChoosesClient;
  if (currentDefect) reasons.push(`A configuração atual (trust proxy = 1) NÃO usa o IP do cliente como chave (${currentChoosesClient ? 'a sequência varia' : 'escolhe um hop interno/da borda'}): todos os visitantes compartilham a chave, que ainda pode variar com o tempo. O defeito se reproduz.`);
  else reasons.push('A configuração atual (trust proxy = 1) já usa o IP do cliente como chave: não há defeito a corrigir por aqui.');
  if (cf.clientControllable) reasons.push('CF-Connecting-IP forjado CHEGOU ao app: o cliente controla o header. NÃO usar.');
  if (!cf.presentAlways) reasons.push('CF-Connecting-IP não chegou em todas as requisições normais. NÃO usar.');
  if (!cf.cfRayAlways) reasons.push('CF-Ray não chegou em todas as requisições (a defesa em profundidade da flag não funcionaria).');
  if (cf.presentAlways && !cf.matchesRealClient) reasons.push('CF-Connecting-IP chegou, mas NÃO é o IP real do cliente.');
  if (!hops.consistent) reasons.push('A posição do IP do cliente na cadeia X-Forwarded-For não é consistente entre requisições.');
  if (hops.consistent && !hops.forgedXffSafe) reasons.push('Um X-Forwarded-For forjado mudou a posição do cliente ou o IP escolhido: contagem por saltos NÃO é segura.');

  if (cf.edgeBlocksForgedCf) reasons.push('A borda bloqueou (403) todo CF-Connecting-IP forjado: o valor do cliente nunca chega ao app.');

  // Preferência: o header quando comprovado, porque FALHA DE FORMA SEGURA — se a
  // plataforma deixar de mandá-lo, o app cai no IP da conexão (o comportamento de
  // hoje). A contagem de saltos falha em silêncio se a cadeia mudar de tamanho
  // (passa a escolher outra entrada, possivelmente uma forjada); fica como plano B.
  let recommendation;
  if (cf.usable && cfBucket.ok) recommendation = { mode: 'cf-header', TRUST_PROXY_HOPS: 1, TRUST_CLOUDFLARE_HEADERS: 'true' };
  else if (hops.usable && hopsBucket.ok) recommendation = { mode: 'trust-proxy-hops', TRUST_PROXY_HOPS: hops.position, TRUST_CLOUDFLARE_HEADERS: 'false' };
  else recommendation = { mode: 'nenhuma-estrategia-comprovada', TRUST_PROXY_HOPS: 1, TRUST_CLOUDFLARE_HEADERS: 'false' };

  return {
    cf, hops, buckets: { cf: cfBucket, hops: hopsBucket, current: currentConfig },
    currentConfig: { trustProxy: 1, choosesClient: currentChoosesClient, defect: currentDefect },
    viable: { cfHeader: cf.usable && cfBucket.ok, trustProxyHops: hops.usable && hopsBucket.ok },
    recommendation, reasons,
  };
}
