// Agente BDR: redige mensagens de prospecção ativa (outbound) sob demanda.
//
// Não conversa sozinho, não qualifica lead, não tem score/critérios — só
// pega um objetivo em texto livre ("convidar pra eventos", "reengajar
// lead frio há 60 dias") e devolve 3 variações de mensagem de WhatsApp
// prontas pra equipe do médico copiar e enviar.
//
// Nada aqui é compartilhado com o SDR (lib/iaAgent.js).

const MODEL = 'claude-haiku-4-5-20251001';

function montarPrompt({ nomeAgente, contexto, objetivo }) {
  return `Você é ${nomeAgente || 'um BDR'}, responsável por escrever mensagens de prospecção ativa (outbound) pelo WhatsApp para a equipe de um médico.

Contexto do médico/negócio (tom de voz, o que oferece, particularidades):
"""
${contexto?.trim() || 'Nenhum contexto configurado — escreva de forma profissional e cordial.'}
"""

Objetivo desta mensagem, descrito pela equipe:
"""
${objetivo.trim()}
"""

Escreva 3 variações diferentes de uma mensagem curta de WhatsApp para esse objetivo. Regras:
- Cada variação curta, como uma mensagem real de WhatsApp — no máximo 3 frases.
- Ângulos diferentes entre as variações (ex: uma mais direta, uma mais consultiva, uma mais informal).
- Português, sem markdown, sem excesso de emojis, pronta pra copiar e enviar.
- Nunca invente dados que não estão no contexto (preço, datas, nomes, horários).

Responda SOMENTE com JSON puro neste formato exato, sem texto antes ou depois:
{ "variacoes": ["mensagem 1", "mensagem 2", "mensagem 3"] }`;
}

// Se a IA não devolver JSON válido, tenta quebrar o texto em linhas.
function parsearVariacoes(texto) {
  try {
    const parsed = JSON.parse(texto);
    const arr = Array.isArray(parsed) ? parsed : parsed?.variacoes;
    if (Array.isArray(arr)) {
      const limpas = arr.map((v) => String(v).trim()).filter(Boolean);
      if (limpas.length > 0) return limpas.slice(0, 3);
    }
  } catch {
    // não veio JSON — cai no fallback abaixo
  }

  return texto
    .split('\n')
    .map((l) => l.replace(/^\s*(\d+[.)\-]|[-*•])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

export async function gerarVariacoesProspeccao({ nomeAgente, contexto, objetivo }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      messages: [{ role: 'user', content: montarPrompt({ nomeAgente, contexto, objetivo }) }],
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error?.message || 'Erro ao gerar mensagens de prospecção');
  }

  const texto = data?.content?.[0]?.text?.trim() || '';
  const variacoes = parsearVariacoes(texto);
  if (variacoes.length === 0) throw new Error('A IA não retornou nenhuma mensagem utilizável');
  return variacoes;
}
