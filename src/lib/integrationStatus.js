// Fonte única de verdade pra "essa integração está de fato operacional?" —
// reutilizada por GET /onboarding e GET /integrations, pra que as duas telas
// nunca mais divirjam sobre o mesmo médico.

import { supabase } from './supabase.js';

// WhatsApp: reflete exatamente o que src/lib/whatsapp.js + seus 3 chamadores
// ativos (campanhas.js, conversations.js, webhooks/whatsapp.js) exigem pra
// tentar enviar uma mensagem — nunca mais, nunca menos.
//   - external_id (phone_number_id) é SEMPRE obrigatório: é parte da própria
//     URL da Graph API (.../{phoneNumberId}/messages), sem fallback possível.
//   - a tela de prontidão exige a credencial PRÓPRIA da integração. O token
//     global continua disponível no caminho de envio apenas como compatibilidade
//     legada, mas não pode fazer uma conta nova parecer conectada: ele pode não
//     ter acesso aos ativos/WABA daquele cliente.
//   - waba_id NUNCA é lido no caminho de envio (só é usado no momento do
//     Embedded Signup, pra inscrever o app na WABA) — por isso nunca entra
//     nesta conta, sozinho ou não.
export function isWhatsappOperacional(integrationRow) {
  const temExternalId = Boolean(integrationRow?.external_id);
  const temTokenProprio = Boolean(integrationRow?.access_token || integrationRow?.access_token_encrypted);
  return temExternalId && temTokenProprio;
}

// Plataformas de venda (kiwify/hotmart/ticto/pagarme): a existência da linha
// em `integrations` ou do `webhook_token` NÃO prova nada — ambos nascem
// automaticamente (GET /integrations upserta as 5 linhas; webhook_token tem
// default no banco). O único sinal real de que o webhook do médico está de
// fato configurado e recebendo eventos é: pelo menos uma linha em
// `transactions` daquele gateway associada a um lead deste médico —
// QUALQUER status (pago, pendente, reembolsado), porque
// paymentFactory.js:registrarTransacao roda pra todo evento autenticado e
// parseado com sucesso, independente do resultado financeiro.
//
// `transactions` não tem doctor_id direto — a ligação é sempre
// transactions.deal_id -> deals.lead_id -> leads.doctor_id (mesmo caminho
// que este arquivo já usava antes desta função existir).
export async function gatewaysComWebhookRecebido(doctorId) {
  const { data: leadsDoMedico } = await supabase.from('leads').select('id').eq('doctor_id', doctorId);
  const leadIds = (leadsDoMedico || []).map((l) => l.id);
  if (leadIds.length === 0) return new Set();

  const { data: dealsDoMedico } = await supabase.from('deals').select('id').in('lead_id', leadIds);
  const dealIds = (dealsDoMedico || []).map((d) => d.id);
  if (dealIds.length === 0) return new Set();

  const { data: transacoes } = await supabase.from('transactions').select('gateway').in('deal_id', dealIds);
  return new Set((transacoes || []).map((t) => t.gateway));
}
