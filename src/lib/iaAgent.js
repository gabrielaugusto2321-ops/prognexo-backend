// Agente de IA que faz a primeira abordagem e qualificação de um lead pelo
// WhatsApp, antes de passar pro closer humano. Usa o contexto que o próprio
// médico escreveu (produto, tom de voz, o que conta como "lead quente") —
// sem regra fixa de qualificação embutida em código, de propósito: cada
// médico define isso à sua maneira, em texto livre, na tela de Integrações.

const MODEL = 'claude-haiku-4-5-20251001';

function montarSystemPrompt(contextoDoMedico) {
  return `Você é a primeira pessoa de contato pelo WhatsApp de um médico. Sua função é conversar com o lead, entender o interesse dele, e decidir se ele está pronto para falar com um closer humano.

Contexto deste médico (produto, tom de voz, o que conta como lead qualificado):
"""
${contextoDoMedico || 'Nenhum contexto configurado ainda — converse de forma genérica, cordial, e classifique como "qualificando" até haver mais sinal de interesse real.'}
"""

Regras:
- Responda como se fosse a equipe do médico, nunca diga que é uma IA.
- Mensagens curtas, como se estivesse digitando no WhatsApp de verdade — não escreva parágrafos longos.
- Nunca invente informação sobre preço, produto ou disponibilidade que não esteja no contexto acima.
- Quando o lead demonstrar intenção real de comprar/agendar (não só curiosidade), classifique como "quente".
- Quando o lead deixar claro que não tem interesse, classifique como "frio".
- Caso contrário, classifique como "qualificando" e continue a conversa.

Responda SEMPRE em JSON puro, sem markdown, neste formato exato:
{"resposta": "texto da mensagem a enviar pro lead", "status": "qualificando" | "quente" | "frio"}`;
}

// historico: array de { direcao: 'recebida'|'enviada', conteudo: string }, mais antigo primeiro
export async function processarMensagemComIA({ contextoDoMedico, historico }) {
  const messages = historico.map((h) => ({
    role: h.direcao === 'recebida' ? 'user' : 'assistant',
    content: h.conteudo,
  }));

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: montarSystemPrompt(contextoDoMedico),
      messages,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error?.message || 'Erro ao chamar a IA');
  }

  const textoBruto = data?.content?.[0]?.text ?? '';
  try {
    const parsed = JSON.parse(textoBruto);
    return {
      resposta: parsed.resposta || 'Oi! Já te retorno.',
      status: ['qualificando', 'quente', 'frio'].includes(parsed.status) ? parsed.status : 'qualificando',
    };
  } catch {
    // Se a IA não devolveu JSON válido por algum motivo, ainda manda a
    // resposta crua pro lead em vez de deixar a conversa muda.
    return { resposta: textoBruto || 'Oi! Já te retorno.', status: 'qualificando' };
  }
}
