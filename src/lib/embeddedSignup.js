import { env } from '../config/env.js';

// Troca o "code" de uso único que o Embedded Signup devolve no navegador
// pelo business access token daquela conexão. Esse token autoriza as ações
// seguintes na WABA/número escolhidos pelo próprio cliente e depois é salvo
// (via CredentialVault) na integração do médico — nunca deve ser logado.
export async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    code,
  });
  const resp = await fetch(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/oauth/access_token?${params}`);
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error?.message || 'Erro ao trocar code por token');
  }
  if (!data?.access_token) throw new Error('Meta não devolveu access token no Embedded Signup');
  return data.access_token;
}

// Registra o número pra uso na Cloud API — obrigatório antes de conseguir
// enviar/receber mensagem por ele. O PIN é qualquer sequência de 6 dígitos
// que você escolhe (fica salvo do lado da Meta, não precisa lembrar depois).
export async function registerPhoneNumber(phoneNumberId, accessToken) {
  if (!accessToken) throw new Error('Access token ausente para registrar o número');
  const url = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${phoneNumberId}/register`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin: '000000' }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error?.message || 'Erro ao registrar o número no WhatsApp Cloud API');
  }
  return data;
}

// Inscreve o nosso app pra receber webhook (mensagem recebida, status de
// entrega) dessa WABA específica. Sem isso o número fica mudo pro nosso lado.
export async function subscribeAppToWaba(wabaId, accessToken) {
  if (!accessToken) throw new Error('Access token ausente para inscrever a WABA');
  const url = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${wabaId}/subscribed_apps`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error?.message || 'Erro ao inscrever o app na WABA');
  }
  return data;
}
