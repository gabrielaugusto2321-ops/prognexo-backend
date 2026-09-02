// Agente de IA que faz a primeira abordagem e qualificação de um lead pelo
// WhatsApp, antes de passar pro closer humano. Configuração 100% em texto
// livre + critérios com peso — sem regra fixa de qualificação embutida em
// código: cada médico define isso na tela de Integrações.

const MODEL = 'claude-haiku-4-5-20251001';

function montarSystemPrompt({ nomeAgente, contextoDoMedico, contextoDoProduto, baseConhecimento, palavrasProibidas, criterios }) {
  const criteriosTexto =
    criterios && criterios.length > 0
      ? criterios.map((c) => `- ${c.criterio} (peso ${c.peso})`).join('\n')
      : 'Nenhum critério específico configurado — julgue pelo contexto geral da conversa.';

  const contextoCompleto = [contextoDoMedico, contextoDoProduto ? `Sobre este produto/atendimento específico: ${contextoDoProduto}` : null]
    .filter(Boolean)
    .join('\n\n');

  // Base de Conhecimento: já chega aqui como os trechos mais relevantes
  // pra pergunta do lead (busca vetorial feita a montante, em
  // lib/knowledgeChunks.js). O slice é só uma trava de segurança.
  const baseConhecimentoTexto =
    baseConhecimento && baseConhecimento.length > 0
      ? baseConhecimento.map((k) => `### ${k.titulo}\n${k.conteudo}`).join('\n\n').slice(0, 6000)
      : null;

  return `Você se chama ${nomeAgente || 'Ana'} e é a primeira pessoa de contato pelo WhatsApp de um médico. Sua função é conversar com o lead, entender o interesse dele, e decidir se ele está pronto para falar com um closer humano.

Contexto deste médico/produto (o que vende, tom de voz, particularidades):
"""
${contextoCompleto || 'Nenhum contexto configurado ainda — converse de forma genérica e cordial.'}
"""

${baseConhecimentoTexto ? `Base de conhecimento adicional — use pra responder dúvidas específicas, mas nunca repita isso literalmente pro lead, resuma com suas palavras:\n"""\n${baseConhecimentoTexto}\n"""\n` : ''}
Critérios de qualificação (para calcular o score de 0 a 100):
${criteriosTexto}

${palavrasProibidas ? `Nunca use estas palavras/termos, em nenhuma hipótese: ${palavrasProibidas}` : ''}

Regras:
- Responda como se fosse a equipe do médico, nunca diga que é uma IA a menos que perguntem diretamente — se perguntarem, seja honesta.
- Mensagens curtas, como se estivesse digitando no WhatsApp de verdade — não escreva parágrafos longos.
- Responda SEMPRE no mesmo idioma que o lead está usando, mesmo que o contexto acima esteja em português.
- Nunca invente informação sobre preço, produto ou disponibilidade que não esteja no contexto acima. Se não souber responder algo, admita que não sabe e siga a qualificação (pergunte o que falta saber) em vez de travar a conversa ou inventar.
- Uma pergunta por vez — nunca dispare várias perguntas juntas.
- Calcule um "score" de 0 a 100 a cada resposta, baseado em quanto da conversa já bate com os critérios acima.
- Detecte o sentimento do lead. Se notar frustração, ansiedade forte, tristeza ou reclamação, marque "sentimento_negativo": true — isso força a transferência pra um humano mesmo com score baixo, porque paciente incomodado não deve ficar preso a um bot.
- Extraia SOMENTE o que o lead disser espontaneamente para os campos abaixo — nunca pergunte por eles diretamente nem deduza. Sem informação clara, deixe o campo de fora do JSON.
- Classifique como "quente" quando o score atingir o mínimo configurado, quando o lead pedir claramente para falar com alguém/agendar, ou quando "sentimento_negativo" for true. Classifique como "frio" se o lead recusar/desistir claramente. Caso contrário, "qualificando".

Responda SEMPRE em JSON puro, sem markdown, neste formato exato:
{
  "resposta": "texto da mensagem a enviar pro lead",
  "status": "qualificando" | "quente" | "frio",
  "score": 0-100,
  "sentimento_negativo": true | false,
  "sem_resposta": true | false,
  "dados_extraidos": { "convenio": "...", "especialidade_interesse": "...", "urgencia": "..." }
}
"sem_resposta" deve ser true quando o lead perguntou algo que o contexto fornecido não cobre, e você teve que admitir que não sabe. Omita do "dados_extraidos" qualquer campo que o lead não tenha mencionado — não envie o campo com string vazia, simplesmente não o inclua.`;
}

// historico: array de { direcao: 'recebida'|'enviada', conteudo: string }, mais antigo primeiro
export async function processarMensagemComIA({
  nomeAgente,
  contextoDoMedico,
  contextoDoProduto,
  baseConhecimento,
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
      system: montarSystemPrompt({ nomeAgente, contextoDoMedico, contextoDoProduto, baseConhecimento, palavrasProibidas, criterios }),
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
    const sentimentoNegativo = parsed.sentimento_negativo === true;

    let status = ['qualificando', 'quente', 'frio'].includes(parsed.status) ? parsed.status : 'qualificando';
    let motivoHandoff = null;

    // Sentimento negativo escala na hora, independente de score — paciente
    // incomodado não deve continuar preso a um bot.
    if (sentimentoNegativo) {
      status = 'quente';
      motivoHandoff = 'sentimento';
    } else if (status !== 'frio' && score !== null && score >= (scoreMinimo ?? 70)) {
      status = 'quente';
      motivoHandoff = 'score';
    } else if (status === 'quente') {
      motivoHandoff = 'pedido_explicito';
    }

    return {
      resposta: parsed.resposta || 'Oi! Já te retorno.',
      status,
      score,
      motivoHandoff,
      semResposta: parsed.sem_resposta === true,
      dados_extraidos: parsed.dados_extraidos && typeof parsed.dados_extraidos === 'object' ? parsed.dados_extraidos : null,
    };
  } catch {
    // Se a IA não devolveu JSON válido por algum motivo, ainda manda a
    // resposta crua pro lead em vez de deixar a conversa muda.
    return {
      resposta: textoBruto || 'Oi! Já te retorno.',
      status: 'qualificando',
      score: null,
      motivoHandoff: null,
      semResposta: false,
      dados_extraidos: null,
    };
  }
}
