import { supabase } from './supabase.js';

// Normaliza o status de qualquer gateway pro vocabulário interno do Prognexo
const STATUS_MAP = {
  // Pagar.me
  paid: 'pago', failed: 'recusado', refunded: 'estornado', pending: 'pendente',
  // Kiwify
  approved: 'pago', refused: 'recusado', refunded_kiwify: 'estornado', chargedback: 'estornado',
  // Hotmart
  PURCHASE_APPROVED: 'pago', PURCHASE_CANCELED: 'recusado', PURCHASE_REFUNDED: 'estornado', PURCHASE_CHARGEBACK: 'estornado',
  // Ticto
  authorized: 'pago', refused_ticto: 'recusado', refunded_ticto: 'estornado',
};

export function normalizeStatus(rawStatus) {
  return STATUS_MAP[rawStatus] ?? 'pendente';
}

// Descobre a QUEM (qual médico) pertence esse webhook, a partir do token
// único que o médico colou no próprio painel da plataforma.
export async function resolveDoctorFromToken(gateway, token) {
  if (!token) return null;
  const { data } = await supabase
    .from('integrations')
    .select('doctor_id')
    .eq('gateway', gateway)
    .eq('webhook_token', token)
    .maybeSingle();
  return data?.doctor_id ?? null;
}

// Grava a transação (idempotente por gateway+id) e, se for pagamento confirmado
// com deal_id conhecido, fecha o deal e sincroniza o lead automaticamente.
export async function registrarTransacao({
  gateway,
  gatewayTransactionId,
  valor,
  status, // já normalizado: 'pago' | 'pendente' | 'recusado' | 'estornado'
  metodoPagamento,
  dealId,
}) {
  await supabase.from('transactions').upsert(
    {
      deal_id: dealId ?? null,
      gateway,
      gateway_transaction_id: String(gatewayTransactionId),
      valor,
      status,
      metodo_pagamento: metodoPagamento,
    },
    { onConflict: 'gateway,gateway_transaction_id' }
  );

  if (status === 'pago' && dealId) {
    const { data: deal } = await supabase
      .from('deals')
      .update({ etapa: 'fechado' })
      .eq('id', dealId)
      .select('lead_id')
      .single();

    if (deal) {
      await supabase.from('leads').update({ status_atual: 'fechado' }).eq('id', deal.lead_id);
    }
  }
}

// Tenta achar o lead pelo e-mail ou telefone do comprador, DENTRO do médico
// certo (evita cruzar leads de médicos diferentes que usam o mesmo e-mail).
export async function encontrarDealPorContato({ email, telefone, doctorId }) {
  if (!doctorId) return null;

  let query = supabase.from('leads').select('id, deals(id)').eq('doctor_id', doctorId).limit(1);

  if (email) query = query.eq('email', email);
  else if (telefone) query = query.eq('telefone', telefone.replace(/\D/g, ''));
  else return null;

  const { data } = await query.maybeSingle();
  return data?.deals?.[0]?.id ?? null;
}
