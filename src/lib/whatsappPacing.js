// FASE 2 — pacing serial por médico. NUNCA tentamos adivinhar o tier de
// throughput da Meta: o operador configura WHATSAPP_SEND_INTERVAL_MS (default
// 1000ms) e todo envio de campanha espera esse intervalo desde o último envio
// PARA O MESMO MÉDICO antes de falar com a Meta de novo.
//
// Implementação EM MEMÓRIA (Map por doctor_id) — só é correta com uma única
// instância de processo rodando o worker (WEB_CONCURRENCY=1 no MVP). Com
// múltiplas instâncias, cada uma teria seu próprio relógio e o intervalo
// combinado com a Meta poderia ser ultrapassado na soma. Documentado também
// em src/config/env.js, ao lado da variável.
const lastSendAtByDoctor = new Map();

export async function waitForSendSlot(doctorId, intervalMs, {
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  const interval = Number(intervalMs) || 0;
  if (interval <= 0 || !doctorId) return;
  const last = lastSendAtByDoctor.get(doctorId) || 0;
  const wait = interval - (now() - last);
  if (wait > 0) await sleepImpl(wait);
  lastSendAtByDoctor.set(doctorId, now());
}

// Só para testes — nunca chamado em código de produção.
export function __resetWhatsAppPacingForTests() {
  lastSendAtByDoctor.clear();
}
