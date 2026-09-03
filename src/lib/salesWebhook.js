import crypto from 'crypto';
import { supabase } from './supabase.js';
import { logger } from './logger.js';
import { CredentialVault } from './credentialVault.js';

// Normaliza o status de qualquer gateway pro vocabulário interno do Prognexo.
const STATUS_MAP = {
  // Pagar.me
  paid: 'pago',
  failed: 'recusado',
  refunded: 'estornado',
  pending: 'pendente',
  // Kiwify
  approved: 'pago',
  refused: 'recusado',
  refunded_kiwify: 'estornado',
  chargedback: 'estornado',
  // Hotmart
  PURCHASE_APPROVED: 'pago',
  PURCHASE_CANCELED: 'recusado',
  PURCHASE_REFUNDED: 'estornado',
  PURCHASE_CHARGEBACK: 'estornado',
  // Ticto (e a grafia correta de "chargeback", comum a várias plataformas)
  authorized: 'pago',
  refused_ticto: 'recusado',
  refunded_ticto: 'estornado',
  chargeback: 'estornado',
};

export function normalizeStatus(rawStatus) {
  return STATUS_MAP[rawStatus] ?? 'pendente';
}

// Descobre a QUEM (qual médico) pertence esse webhook, a partir do token único
// que o médico colou no próprio painel da plataforma.
export async function resolveDoctorFromToken(gateway, token) {
  if (!token) return null;
  // Via CredentialVault: blind index (HMAC) + confirmação timing-safe quando a
  // cripto está ligada; igualdade direta no modo legado.
  const hit = await CredentialVault.resolveIntegrationByWebhookToken({ gateway, token });
  return hit?.doctor_id ?? null;
}

// Idempotência durável: registra o evento uma única vez por (provider, id).
// Retorna o id do registro criado, ou null se o evento já tinha sido recebido
// (nesse caso o chamador NÃO deve reprocessar).
// Depende da tabela `webhook_events` (migration 0005).
export async function claimWebhookEvent({ provider, externalEventId, signatureValid, rawBody }) {
  const payloadHash = crypto
    .createHash('sha256')
    .update(rawBody || Buffer.alloc(0))
    .digest('hex');

  const { data, error } = await supabase
    .from('webhook_events')
    .upsert(
      {
        provider,
        external_event_id: String(externalEventId),
        signature_valid: signatureValid,
        payload_hash: payloadHash,
        status: 'processing',
      },
      { onConflict: 'provider,external_event_id', ignoreDuplicates: true }
    )
    .select('id')
    .maybeSingle();

  if (error) throw error;
  return data?.id ?? null;
}

// Grava a transação (idempotente por gateway+id) e, se for pagamento confirmado
// com deal conhecido, fecha o deal e sincroniza o lead.
// O `dealId` vem do payload do webhook e por isso é SEMPRE validado contra o
// `doctorId` resolvido pelo token/assinatura — nunca fecha deal de outra clínica.
export async function registrarTransacao({
  gateway,
  gatewayTransactionId,
  valor,
  status, // já normalizado: 'pago' | 'pendente' | 'recusado' | 'estornado'
  metodoPagamento,
  dealId,
  doctorId,
  eventId,
}) {
  let validDeal = null;

  if (dealId) {
    const { data, error } = await supabase
      .from('deals')
      .select('id, lead_id, leads!inner(doctor_id)')
      .eq('id', dealId)
      .maybeSingle();
    if (error) throw error;

    if (data?.leads?.doctor_id !== doctorId) {
      logger.warn({ gateway, eventId, dealId }, 'Cross-tenant deal ignored');
      return { ignored: true };
    }
    validDeal = data;
  }

  const { error: txError } = await supabase.from('transactions').upsert(
    {
      deal_id: validDeal?.id ?? null,
      gateway,
      gateway_transaction_id: String(gatewayTransactionId),
      valor,
      status,
      metodo_pagamento: metodoPagamento,
    },
    { onConflict: 'gateway,gateway_transaction_id' }
  );
  if (txError) throw txError;

  if (status === 'pago' && validDeal) {
    const dealUpdate = await supabase.from('deals').update({ etapa: 'fechado' }).eq('id', validDeal.id);
    if (dealUpdate.error) throw dealUpdate.error;
    const leadUpdate = await supabase.from('leads').update({ status_atual: 'fechado' }).eq('id', validDeal.lead_id);
    if (leadUpdate.error) throw leadUpdate.error;
  }

  await supabase
    .from('webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString() })
    .eq('provider', gateway)
    .eq('external_event_id', String(eventId || gatewayTransactionId));

  return { ignored: false };
}

// Tenta achar o deal pelo e-mail ou telefone do comprador, DENTRO do médico
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
