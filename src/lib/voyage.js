// Cliente da Voyage AI para gerar embeddings de texto.
// Modelo: voyage-3.5-lite, 1024 dimensões (precisa bater com a coluna
// vector(1024) da tabela knowledge_chunks).
//
// A chave vem de VOYAGE_API_KEY (configurada no Render).

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3.5-lite';
export const EMBEDDING_DIMS = 1024;

// input_type melhora o retrieval: 'document' pros textos guardados,
// 'query' pra pergunta do lead na hora da busca.
async function chamarVoyage(input, inputType) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY não configurada');

  const resp = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      input,
      input_type: inputType,
      output_dimension: EMBEDDING_DIMS,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.detail || data?.error?.message || 'Erro ao gerar embedding na Voyage AI');
  }

  // A Voyage devolve os embeddings com um campo "index" — reordena por
  // segurança pra casar com a ordem dos textos de entrada.
  return (data.data || [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

// Vários textos de uma vez (usado na ingestão dos chunks de um item).
export async function gerarEmbeddings(textos, inputType = 'document') {
  if (!Array.isArray(textos) || textos.length === 0) return [];
  return chamarVoyage(textos, inputType);
}

// Um texto só (usado pra embedar a pergunta do lead).
export async function gerarEmbedding(texto, inputType = 'query') {
  const [embedding] = await chamarVoyage([texto], inputType);
  return embedding;
}

// pgvector aceita o literal de texto "[0.1,0.2,...]" via PostgREST, que
// faz o cast pra vector automaticamente.
export function paraLiteralVetor(embedding) {
  return `[${embedding.join(',')}]`;
}
