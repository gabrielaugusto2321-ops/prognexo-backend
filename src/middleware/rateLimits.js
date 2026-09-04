import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Store do rate-limit.
//
// HOJE: store em memória do processo. Isso protege UMA instância. Com várias
// instâncias atrás de um load balancer, cada uma conta separadamente e o limite
// efetivo é multiplicado pelo número de réplicas.
//
// FASE 2: para um store compartilhado (Redis/Upstash), passe `store: <store>`
// para cada `rateLimit({...})` abaixo (o express-rate-limit v7 lê `store` uma
// única vez, na construção — não dá para injetar depois). O contrato é a
// interface `Store` do express-rate-limit v7 (ex.: `rate-limit-redis`).
//
// `assertRateLimitStoreReady()` roda no boot: se o ambiente declara múltiplas
// instâncias, falha de forma explícita em vez de degradar a proteção em silêncio.
// ---------------------------------------------------------------------------

// Trocar para o store compartilhado aqui quando existir (Fase 2).
const store = undefined;

export function assertRateLimitStoreReady() {
  const multiInstance = env.APP_INSTANCE_COUNT && Number(env.APP_INSTANCE_COUNT) > 1;
  if (env.NODE_ENV === 'production' && multiInstance && !store) {
    throw new Error(
      'rate_limit_store_misconfigured: APP_INSTANCE_COUNT > 1 exige um store compartilhado (Redis) — ' +
        'configure `store` em src/middleware/rateLimits.js antes de escalar.'
    );
  }
  if (env.NODE_ENV === 'production' && !store) {
    logger.warn(
      { instances: env.APP_INSTANCE_COUNT || 1 },
      'Rate limit usando store em memória — protege apenas esta instância'
    );
  }
}

const base = { standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited' }, store };

// IPv6-safe: agrupa por prefixo /64 quando a chave é o IP.
function ipKey(req) {
  const ip = req.ip || '';
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
}

export const globalLimiter = rateLimit({ ...base, windowMs: 15 * 60_000, limit: 300 });
export const authLimiter = rateLimit({ ...base, windowMs: 15 * 60_000, limit: 20 });
export const signupHourlyLimiter = rateLimit({ ...base, windowMs: 60 * 60_000, limit: 5 });
export const signupDailyLimiter = rateLimit({ ...base, windowMs: 24 * 60 * 60_000, limit: 20 });
export const activationLimiter = rateLimit({ ...base, windowMs: 15 * 60_000, limit: 10 });
export const checkoutLimiter = rateLimit({ ...base, windowMs: 60 * 60_000, limit: 10 });
export const webhookLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 600 });

// IA: por usuário autenticado quando houver, senão por IP.
export const aiLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 30,
  keyGenerator: (req) => req.user?.id || ipKey(req),
});

// FASE 2.4 — rotação de segredo de webhook: operação sensível e rara.
// Por usuário autenticado; janela curta e limite baixo.
export const webhookTokenRotateLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 5,
  keyGenerator: (req) => req.user?.id || ipKey(req),
});

// FASE 2.6 — mutações de equipe (convidar/alterar papel/suspender/reativar/
// remover/unidades): sensível (convite dispara e-mail; risco de spam/abuso).
export const teamMutationLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req) => req.user?.id || ipKey(req),
});
