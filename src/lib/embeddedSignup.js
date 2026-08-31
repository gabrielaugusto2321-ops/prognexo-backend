const GRAPH_API_VERSION = 'v20.0';

// Troca o "code" que o Embedded Signup devolve no navegador por um access
// token de usuário. Esse token não é o que usamos pra enviar mensagem no
// dia a dia (isso é o token do usuário de sistema, fixo, em META_SYSTEM_USER_TOKEN)
// — ele serve só pra confirmar que o fluxo de login foi concluído direito.
export async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    code,
  });
  const resp = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token?${params}`);
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error?.message || 'Erro ao trocar code por token');
  }
  return data.access_token;
}

// Registra o número pra uso na Cloud API — obrigatório antes de conseguir
// enviar/receber mensagem por ele. O PIN é qualquer sequência de 6 dígitos
// que você escolhe (fica salvo do lado da Meta, não precisa lembrar depois).
export async function registerPhoneNumber(phoneNumberId) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/register`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.META_SYSTEM_USER_TOKEN}`,
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
export async function subscribeAppToWaba(wabaId) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/subscribed_apps`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.META_SYSTEM_USER_TOKEN}` },
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error?.message || 'Erro ao inscrever o app na WABA');
  }
  return data;
}
