const GRAPH_API_VERSION = 'v20.0';

// Envia uma mensagem de texto livre pelo número (phone_number_id) e token
// de acesso de um médico específico. Só funciona dentro da janela de 24h
// desde a última mensagem RECEBIDA do lead — fora disso a Meta rejeita
// com erro de "re-engagement message" e exige um template aprovado.
export async function sendWhatsAppMessage(phoneNumberId, accessToken, to, texto) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

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
