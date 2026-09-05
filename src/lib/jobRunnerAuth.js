import crypto from 'node:crypto';

// FASE 2.8 — autenticação do worker da fila de jobs.
//
// SÓ por header, NUNCA por query string (?secret= contraria o hardening
// contra segredo em URL — a URL vaza em logs de proxy, histórico, referer).
// Aceita `Authorization: Bearer <token>` OU `X-Prognexo-Job-Token: <token>`.
// Comparação timing-safe. O token nunca é logado (o pino redact cobre
// `req.headers.authorization` e `req.headers.x-prognexo-job-token`).
//
// Resposta genérica 401 (nunca diz "token errado" vs "token ausente").
export function verifyJobRunnerToken(req) {
  const expected = process.env.JOB_RUNNER_SECRET;
  if (!expected) return false;

  const auth = req.headers?.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  const provided = bearer ? bearer[1] : (req.headers?.['x-prognexo-job-token'] || '');
  if (!provided) return false;

  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) {
    // timingSafeEqual exige mesmo tamanho — compara contra si mesmo para
    // manter o custo constante e não vazar o tamanho do segredo.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function requireJobRunnerAuth(req, res, next) {
  if (!verifyJobRunnerToken(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
}
