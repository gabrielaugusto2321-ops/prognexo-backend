import { supabase } from './supabase.js';
import { logger } from './logger.js';

// Checagem de readiness do schema. As migrations 0004/0005/0006 NÃO são aplicadas
// automaticamente — se o backend subir antes delas, funcionalidades que dependem
// de idempotência (webhooks) NÃO devem processar em produção sem essa garantia.
//
// Esta checagem não expõe detalhes de schema ao cliente; só decide o gate.

// Só cacheamos o resultado POSITIVO — assim, se o backend subir antes da
// migration e ela for aplicada depois, a próxima requisição já reconhece a
// tabela sem precisar de restart. O negativo é re-checado (query barata).
const ready = new Set();

async function tableExists(name) {
  if (ready.has(name)) return true;
  try {
    const { error } = await supabase.from(name).select('id').limit(0);
    if (error) {
      logger.warn({ table: name }, 'Readiness: required table not available');
      return false;
    }
    ready.add(name);
    return true;
  } catch (err) {
    logger.warn({ table: name, err }, 'Readiness check failed');
    return false;
  }
}

// Idempotência de webhook exige `webhook_events` (migration 0005).
export function webhookIdempotencyReady() {
  return tableExists('webhook_events');
}

// Envio de campanha em lote exige `campanha_envios` (migration 0006).
export function campaignLedgerReady() {
  return tableExists('campanha_envios');
}

export function _resetReadinessCache() {
  ready.clear();
}
