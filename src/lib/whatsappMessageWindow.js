// Janela de 24h do WhatsApp Cloud API para mensagem de texto livre — fonte
// ÚNICA usada por todos os caminhos de envio (manual, campanha legada,
// worker). Antes desta função existir, a mesma constante `24 * 60 * 60 * 1000`
// e a mesma query de "última mensagem recebida" estavam duplicadas em cada
// caminho; centralizar evita que um deles fique divergente no futuro.
export const WHATSAPP_FREE_TEXT_WINDOW_MS = 24 * 60 * 60 * 1000;

// `lastInboundTimestampMsg` é o `timestamp_msg` da última `conversations`
// com `direcao='recebida'` do lead (ou null/undefined se nunca respondeu).
// Retorna false tanto quando não há mensagem recebida quanto quando a última
// já passou da janela — nunca lança.
export function isWithinFreeTextWindow(lastInboundTimestampMsg) {
  if (!lastInboundTimestampMsg) return false;
  const elapsed = Date.now() - new Date(lastInboundTimestampMsg).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < WHATSAPP_FREE_TEXT_WINDOW_MS;
}
