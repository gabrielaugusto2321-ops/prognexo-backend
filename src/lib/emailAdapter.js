import { env } from '../config/env.js';

const FROM = 'Prognexo <contato@prognexo.com.br>';

export function fakeEmailAdapter() {
  const sent = [];
  return {
    sent,
    async sendInvitationEmail(message) {
      // Deliberadamente sem fetch/socket: adapter determinístico para dev/teste.
      sent.push({ ...message });
      return { id: `fake-${sent.length}` };
    },
  };
}

// FASE 2.7 — risco residual documentado (não escondido): a entrega é
// AT-LEAST-ONCE, nunca exactly-once. Se o provedor aceitar o e-mail (resposta
// 2xx) e o processo cair ANTES de `team_outbox_mark_sent` persistir, o
// evento continua 'processing' até a lease expirar e é reclamado por outro
// worker — que tenta enviar de novo. O `Idempotency-Key` do Resend
// (confirmado nos docs: dedupe por até 24h, chave de até 256 caracteres)
// reduz bastante essa janela usando o `idempotency_key` do PRÓPRIO
// outbox_event (estável entre tentativas do mesmo evento — nunca muda em
// retry) — mas não elimina o risco: (a) se o evento ficar mais de 24h em
// retry (bem acima do teto real de backoff desta fase, mas não impossível
// com `max_attempts` alto o suficiente), a proteção expira; (b) isso cobre
// só duplicidade dentro do PRÓPRIO Resend — não cobre um provedor diferente
// nem uma falha de rede exatamente na resposta (e-mail saiu, resposta nunca
// chegou). Duplicidade controlada e rara é aceita nesta fase; não é
// alegado exactly-once em nenhum lugar.
// Montagem pura do request HTTP — SEM nenhuma guarda de ambiente, exportada
// separadamente só para poder testar a lógica do header de idempotência sem
// jamais enfraquecer a recusa de instanciação de `resendEmailAdapter()` em
// teste (guarda abaixo, essa sim, é a fronteira de segurança real: nenhum
// teste deve conseguir montar um adapter que aponta pra api.resend.com).
export function buildResendRequest({ apiKey, to, actionLink, organizationName, idempotencyKey }) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  // Resend trunca/rejeita chaves > 256 chars — o nosso idempotency_key
  // (`<invitation_id>:send:<event_id>`) nunca chega perto disso, mas o
  // slice é uma defesa barata contra qualquer formato futuro maior.
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 256);
  return {
    url: 'https://api.resend.com/emails',
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: FROM,
        to,
        subject: `Convite para ${organizationName || 'Prognexo'}`,
        html: `<p>Você recebeu um convite.</p><p><a href="${actionLink}">Aceitar convite</a></p>`,
      }),
    },
  };
}

export function resendEmailAdapter({ apiKey = env.RESEND_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (env.NODE_ENV === 'test') throw new Error('resend_disabled_in_test');
  if (env.TEAM_INVITE_OUTBOX_ENABLED !== 'true' || env.TEAM_INVITE_EMAIL_DELIVERY_ENABLED !== 'true') {
    throw new Error('resend_flags_disabled');
  }
  if (!apiKey) throw new Error('resend_not_configured');
  return {
    async sendInvitationEmail({ to, actionLink, organizationName, idempotencyKey }) {
      const { url, init } = buildResendRequest({ apiKey, to, actionLink, organizationName, idempotencyKey });
      const response = await fetchImpl(url, init);
      if (!response.ok) throw new Error('email_delivery_failed');
      return response.json();
    },
  };
}

// Reenvio de convite de médico de cortesia (src/routes/adminDoctors.js).
// `supabase.auth.resend({type:'signup'})` é documentado pro fluxo signUp()
// client-side (aquele que popula confirmation_sent_at) — NÃO é garantido
// reenviar o convite de inviteUserByEmail (ação 'invite' no GoTrue, rastreada
// separada da ação 'signup'). O mecanismo correto e documentado pra regenerar
// um convite existente é generateLink({type:'invite'}) — nunca cria usuário
// duplicado (reaproveita o auth.users já criado), mas NÃO envia e-mail
// sozinho, então enviamos nós mesmos via Resend (reaproveita buildResendRequest,
// já usado pelo outbox de convites de equipe).
export async function sendCourtesyInviteEmail({ to, actionLink, clinicName, apiKey = env.RESEND_API_KEY, fetchImpl = globalThis.fetch }) {
  if (env.NODE_ENV === 'test') throw new Error('resend_disabled_in_test');
  if (!apiKey) throw new Error('resend_not_configured');
  const { url, init } = buildResendRequest({ apiKey, to, actionLink, organizationName: clinicName });
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error('email_delivery_failed');
  return response.json();
}

let devFake;
export function configuredTeamInviteEmailAdapter() {
  if (env.NODE_ENV !== 'test' && env.TEAM_INVITE_OUTBOX_ENABLED === 'true' && env.TEAM_INVITE_EMAIL_DELIVERY_ENABLED === 'true') {
    return resendEmailAdapter();
  }
  if (env.APP_ENV === 'production' || env.APP_ENV === 'staging') {
    throw new Error('team_invite_email_delivery_disabled');
  }
  devFake ||= fakeEmailAdapter();
  return devFake;
}
