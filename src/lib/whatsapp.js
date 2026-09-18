import { env } from '../config/env.js';

// Envia uma mensagem de texto livre pelo número (phone_number_id) e token
// de acesso de um médico específico. Só funciona dentro da janela de 24h
// desde a última mensagem RECEBIDA do lead — fora disso a Meta rejeita
// com erro de "re-engagement message" e exige um template aprovado.
export async function sendWhatsAppMessage(phoneNumberId, accessToken, to, texto) {
  const url = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: texto },
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    const mensagem = data?.error?.message || 'Erro desconhecido ao enviar mensagem no WhatsApp';
    const erro = new Error(mensagem);
    erro.metaError = data?.error;
    throw erro;
  }
  return data; // { messages: [{ id: 'wamid...' }] }
}

// Envia um template aprovado (FASE 2) — único jeito de reabrir uma conversa
// fora da janela de 24h. `bodyParameters` já vem pronto (ver
// renderTemplateBodyParameters em src/lib/whatsappTemplates.js) — esta função
// só monta o payload e chama a Meta, nunca decide se o template pode ser
// usado (isso é revalidado antes de chegar aqui).
export async function sendWhatsAppTemplate(phoneNumberId, accessToken, to, { name, languageCode, bodyParameters = [] }, { timeoutMs = 20_000 } = {}) {
  const url = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name,
          language: { code: languageCode },
          ...(bodyParameters.length ? { components: [{ type: 'body', parameters: bodyParameters }] } : {}),
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // fetch REJEITOU (timeout do AbortController, conexão derrubada, DNS) —
    // nunca sabemos se a Meta chegou a processar a requisição. O chamador
    // trata isso como "resultado desconhecido": nunca reenviar silenciosamente.
    throw Object.assign(new Error('whatsapp_template_send_network_error'), { networkError: true, cause: err?.name || 'fetch_failed' });
  } finally {
    clearTimeout(timer);
  }

  let data;
  try {
    data = await resp.json();
  } catch (parseErr) {
    if (resp.ok) {
      // HTTP 2xx mas corpo ilegível: a Meta pode muito bem ter aceitado a
      // mensagem — não há como confirmar nem negar, e não temos o message_id.
      // Trata como resultado ambíguo (mesmo caminho do timeout/desconexão):
      // nunca reenviar às cegas, nunca cair no retry automático.
      throw Object.assign(new Error('whatsapp_template_send_ambiguous_response'), { networkError: true, cause: 'unparseable_success_body' });
    }
    // Erro HTTP explícito (4xx/5xx) sem corpo JSON legível: ainda é uma
    // rejeição confirmada pela Meta (não foi aceito) — seguro pro retry
    // padrão, só não temos o código específico do erro.
    throw Object.assign(new Error('whatsapp_template_send_http_error'), { metaError: null, cause: parseErr?.name || 'invalid_json' });
  }
  if (!resp.ok) {
    const mensagem = data?.error?.message || 'Erro desconhecido ao enviar template no WhatsApp';
    const erro = new Error(mensagem);
    erro.metaError = data?.error;
    throw erro;
  }
  // Só o message_id sanitizado — nunca a resposta bruta da Meta (pode conter
  // metadados de contato) sobe além desta função.
  const messageId = data?.messages?.[0]?.id ?? null;
  return { messageId };
}
