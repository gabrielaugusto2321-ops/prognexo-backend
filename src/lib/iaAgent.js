// Agente de IA que faz a primeira abordagem e qualificação de um lead pelo
// WhatsApp, antes de passar pro closer humano. Configuração 100% em texto
// livre + critérios com peso — sem regra fixa de qualificação embutida em
// código: cada médico define isso na tela de Integrações.

const MODEL = 'claude-haiku-4-5-20251001';

function montarSystemPrompt({ nomeAgente, contextoDoMedico, contextoDoProduto, palavrasProibidas, criterios }) {
  const criteriosTexto =
    criterios && criterios.length > 0
      ? criterios.map((c) => `- ${c.criterio} (peso ${c.peso})`).join('\n')
      : 'Nenhum critério específico configurado — julgue pelo contexto geral da conversa.';

  const contextoCompleto = [contextoDoMedico, contextoDoProduto ? `Sobre este produto/atendimento específico: ${contextoDoProduto}` : null]
    .filter(Boolean)
    .join('\n\n');

  return `Você se chama ${nomeAgente || 'Ana'} e é a primeira pessoa de contato pelo WhatsApp de um médico. Sua função é conversar com o lead, entender o interesse dele, e decidir se ele está pronto para falar com um closer humano.

Contexto deste médico/produto (o que vende, tom de voz, particularidades):
"""
${contextoCompleto || 'Nenhum contexto configurado ainda — converse de forma genérica e cordial.'}
"""

Critérios de qualificação (para calcular o score de 0 a 100):
${criteriosTexto}

${palavrasProibidas ? `Nunca use estas palavras/termos, em nenhuma hipótese: ${palavrasProibidas}` : ''}

Regras:
- Responda como se fosse a equipe do médico, nunca diga que é uma IA a menos que perguntem diretamente — se perguntarem, seja honesta.
- Mensagens curtas, como se estivesse digitando no WhatsApp de verdade — não escreva parágrafos longos.
- Nunca invente informação sobre preço, produto ou disponibilidade que não esteja no contexto acima.
- Uma pergunta por vez — nunca dispare várias perguntas juntas.
- Calcule um "score" de 0 a 100 a cada resposta, baseado em quanto da conversa já bate com os critérios acima.
- Extraia SOMENTE o que o lead disser espontaneamente para os campos abaixo — nunca pergunte por eles diretamente nem deduza. Sem informação clara, deixe o campo de fora do JSON.
- Classifique como "quente" quando o score atingir o mínimo configurado OU quando o lead pedir claramente para falar com alguém/agendar. Classifique como "frio" se o lead recusar/desistir claramente. Caso contrário, "qualificando".

Responda SEMPRE em JSON puro, sem markdown, neste formato exato:
{
  "resposta": "texto da mensagem a enviar pro lead",
  "status": "qualificando" | "quente" | "frio",
  "score": 0-100,
  "dados_extraidos": { "convenio": "...", "especialidade_interesse": "...", "urgencia": "..." }
}
Omita do "dados_extraidos" qualquer campo que o lead não tenha mencionado — não envie o campo com string vazia, simplesmente não o inclua.`;
}

// historico: array de { direcao: 'recebida'|'enviada', conteudo: string }, mais antigo primeiro
export async function processarMensagemComIA({
  nomeAgente,
  contextoDoMedico,
  contextoDoProduto,
  palavrasProibidas,
  criterios,
  scoreMinimo,
  historico,
}) {
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
      max_tokens: 500,
      system: montarSystemPrompt({ nomeAgente, contextoDoMedico, contextoDoProduto, palavrasProibidas, criterios }),
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
    const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : null;

    // Rede de segurança: mesmo que o modelo não tenha marcado "quente", se o
    // score já bate o mínimo configurado, trata como quente de qualquer jeito.
    let status = ['qualificando', 'quente', 'frio'].includes(parsed.status) ? parsed.status : 'qualificando';
    if (status !== 'frio' && score !== null && score >= (scoreMinimo ?? 70)) {
      status = 'quente';
    }

    return {
      resposta: parsed.resposta || 'Oi! Já te retorno.',
      status,
      score,
      dados_extraidos: parsed.dados_extraidos && typeof parsed.dados_extraidos === 'object' ? parsed.dados_extraidos : null,
    };
  } catch {
    // Se a IA não devolveu JSON válido por algum motivo, ainda manda a
    // resposta crua pro lead em vez de deixar a conversa muda.
    return { resposta: textoBruto || 'Oi! Já te retorno.', status: 'qualificando', score: null, dados_extraidos: null };
  }
}
