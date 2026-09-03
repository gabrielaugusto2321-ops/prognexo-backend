import crypto from 'crypto';
import { env } from '../config/env.js';

// Armazenamento temporário server-side para o `state` do OAuth (R06).
//
// O `state` enviado ao provedor é APENAS um nonce opaco de alta entropia — não
// carrega nenhuma informação (nem user id, nem tenant). O servidor guarda o
// contexto associado e o consome UMA única vez no callback.
//
// Propriedades:
//  - nonce aleatório (32 bytes, base64url) — impossível de forjar uma entrada válida;
//  - expiração curta (TTL_MS);
//  - uso único (removido ao consumir);
//  - vínculo com usuário/role/fluxo capturado no início;
//  - rejeita state ausente, desconhecido, expirado ou já usado.
//
// LIMITAÇÃO: store em memória do processo (como o rate-limit). Com múltiplas
// instâncias, mover para um store compartilhado — ver
// docs/platform/13-adr-redis-job-queue.md. `APP_INSTANCE_COUNT` > 1 já derruba
// o boot pelo assertRateLimitStoreReady().

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 5000;

/** @type {Map<string, { userId: string, role: string, flow: string, createdAt: number }>} */
const store = new Map();

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [nonce, ctx] of store) {
    if (ctx.createdAt < cutoff) store.delete(nonce);
  }
}

export function createOAuthState({ userId, role, flow }) {
  sweep();
  if (store.size >= MAX_ENTRIES) {
    // Proteção contra crescimento: remove o mais antigo.
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  const nonce = crypto.randomBytes(32).toString('base64url');
  store.set(nonce, { userId, role, flow, createdAt: Date.now() });
  return nonce;
}

// Consome o state: retorna o contexto e o REMOVE (uso único). Retorna null para
// state ausente, desconhecido, expirado ou já consumido.
export function consumeOAuthState(nonce, expectedFlow) {
  if (!nonce || typeof nonce !== 'string') return null;
  const ctx = store.get(nonce);
  if (!ctx) return null;
  store.delete(nonce); // uso único — mesmo que expirado/errado, não pode ser reusado
  if (Date.now() - ctx.createdAt > TTL_MS) return null;
  if (expectedFlow && ctx.flow !== expectedFlow) return null;
  return ctx;
}

// Redirect só é permitido para origens da allowlist (as mesmas do CORS).
export function isAllowedRedirectBase(url) {
  try {
    const target = new URL(url);
    const allowed = (env.CORS_ALLOWED_ORIGINS || env.FRONTEND_URL || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => {
        try {
          return new URL(v).origin;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return allowed.includes(target.origin);
  } catch {
    return false;
  }
}

export function _resetOAuthStateStore() {
  store.clear();
}

// Seam de teste: envelhece uma entrada para simular expiração.
export function _expireOAuthState(nonce) {
  const ctx = store.get(nonce);
  if (ctx) ctx.createdAt = Date.now() - TTL_MS - 1000;
}
