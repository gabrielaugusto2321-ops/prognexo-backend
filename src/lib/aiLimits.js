// Limites determinísticos (hard caps) para qualquer chamada de IA.
// Rejeitados ANTES de qualquer chamada externa paga.
//
// Quota persistente por tenant (mês) depende do modelo multitenant da Fase 2 —
// a interface está em `TenantAiQuota` abaixo; por ora só os hard caps valem.

export const AI_LIMITS = {
  MAX_HISTORY_MESSAGES: 30,
  MAX_MESSAGE_CHARS: 2000,
  MAX_HISTORY_TOTAL_CHARS: 12_000,
  MAX_PRODUCT_CONTEXT_CHARS: 2000,
  MAX_TOKENS: 500, // teto conservador na resposta do modelo
  CALL_TIMEOUT_MS: 20_000,
  MAX_CONCURRENT_PER_TENANT: 2,
  MAX_CONCURRENT_GLOBAL: 20,
};

// Valida um histórico de conversa contra os hard caps. Retorna
// { ok: true } ou { ok: false, reason }. Nunca lança.
export function checkHistoryLimits(historico, productContext) {
  if (!Array.isArray(historico) || historico.length === 0) {
    return { ok: false, reason: 'historico_vazio' };
  }
  if (historico.length > AI_LIMITS.MAX_HISTORY_MESSAGES) {
    return { ok: false, reason: 'historico_muito_longo' };
  }
  let total = 0;
  for (const msg of historico) {
    const texto = typeof msg?.conteudo === 'string' ? msg.conteudo : '';
    if (texto.length > AI_LIMITS.MAX_MESSAGE_CHARS) return { ok: false, reason: 'mensagem_muito_grande' };
    total += texto.length;
  }
  if (total > AI_LIMITS.MAX_HISTORY_TOTAL_CHARS) return { ok: false, reason: 'historico_muito_grande' };
  if (typeof productContext === 'string' && productContext.length > AI_LIMITS.MAX_PRODUCT_CONTEXT_CHARS) {
    return { ok: false, reason: 'contexto_produto_muito_grande' };
  }
  return { ok: true };
}

// Semáforo de concorrência em processo (por tenant + global). Suficiente para
// uma instância; com várias instâncias vira um limite por-instância (documentar).
const perTenant = new Map();
let globalInFlight = 0;

export function tryAcquireAiSlot(tenantKey) {
  if (globalInFlight >= AI_LIMITS.MAX_CONCURRENT_GLOBAL) return null;
  const current = perTenant.get(tenantKey) || 0;
  if (current >= AI_LIMITS.MAX_CONCURRENT_PER_TENANT) return null;
  perTenant.set(tenantKey, current + 1);
  globalInFlight += 1;
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    globalInFlight -= 1;
    const n = (perTenant.get(tenantKey) || 1) - 1;
    if (n <= 0) perTenant.delete(tenantKey);
    else perTenant.set(tenantKey, n);
  };
}

// Interface para a quota persistente por tenant (Fase 2). Implementação atual
// é um no-op — os hard caps acima é que protegem hoje.
export const TenantAiQuota = {
  async check(/* organizationId, metric */) {
    return { allowed: true, remaining: null };
  },
  async record(/* organizationId, metric, amount */) {
    /* Fase 2: persistir usage_events / usage_quotas */
  },
};
