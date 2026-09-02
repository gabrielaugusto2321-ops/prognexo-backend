// Ingestão e busca da base de conhecimento vetorial.
//
// Ingestão (inline/síncrona): ao criar/editar um item da knowledge_base,
// apaga os chunks antigos daquele item, divide o texto novo em pedaços,
// gera embedding de cada um via Voyage AI e salva em knowledge_chunks.
//
// Busca: embeda a pergunta do lead e chama a RPC match_knowledge_chunks,
// respeitando um limiar de similaridade e um orçamento de tokens.

import { supabase } from './supabase.js';
import { gerarEmbeddings, gerarEmbedding, paraLiteralVetor } from './voyage.js';

const MAX_CHARS_CHUNK = 1000; // ~250 tokens
const OVERLAP_CHARS = 150; // continuidade entre chunks vizinhos

// Divide o texto tentando respeitar quebras de parágrafo; se um parágrafo
// sozinho já passa do limite, quebra ele em pedaços com sobreposição.
export function dividirEmChunks(texto, { maxChars = MAX_CHARS_CHUNK, overlap = OVERLAP_CHARS } = {}) {
  const limpo = (texto || '').replace(/\r\n/g, '\n').trim();
  if (!limpo) return [];

  const paragrafos = limpo.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let atual = '';

  const empurrar = () => {
    const t = atual.trim();
    if (t) chunks.push(t);
    atual = '';
  };

  for (const p of paragrafos) {
    if (p.length > maxChars) {
      empurrar();
      for (let i = 0; i < p.length; i += maxChars - overlap) {
        chunks.push(p.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if ((atual + '\n\n' + p).trim().length > maxChars) empurrar();
    atual = atual ? `${atual}\n\n${p}` : p;
  }
  empurrar();

  return chunks.filter(Boolean);
}

// Reindexa um item da knowledge_base. `item` precisa ter { id, doctor_id,
// titulo, conteudo }. Apaga os chunks antigos sempre; só regera embeddings
// se ainda houver texto.
export async function reindexarKnowledgeBaseItem(item) {
  if (!item?.id || !item?.doctor_id) throw new Error('item inválido para reindexação');

  const { error: erroDelete } = await supabase
    .from('knowledge_chunks')
    .delete()
    .eq('knowledge_base_id', item.id);
  if (erroDelete) throw new Error(`Erro ao limpar chunks antigos: ${erroDelete.message}`);

  const textos = dividirEmChunks(item.conteudo);
  if (textos.length === 0) return { chunks: 0 };

  // Embeda o chunk com o título na frente — dá contexto e melhora o
  // retrieval — mas guarda o conteúdo "puro" na coluna, pra montar o
  // prompt sem poluir com o título repetido.
  const paraEmbedar = textos.map((t) => (item.titulo ? `${item.titulo}\n\n${t}` : t));
  const embeddings = await gerarEmbeddings(paraEmbedar, 'document');

  const linhas = textos.map((conteudo, i) => ({
    knowledge_base_id: item.id,
    doctor_id: item.doctor_id,
    titulo: item.titulo || null,
    conteudo,
    chunk_index: i,
    embedding: paraLiteralVetor(embeddings[i]),
  }));

  const { error: erroInsert } = await supabase.from('knowledge_chunks').insert(linhas);
  if (erroInsert) throw new Error(`Erro ao salvar chunks: ${erroInsert.message}`);

  return { chunks: linhas.length };
}

// Estimativa grosseira de tokens (~4 chars/token) pra respeitar orçamento.
const estimarTokens = (txt) => Math.ceil((txt || '').length / 4);

// Busca os trechos mais relevantes pra uma pergunta. Retorna no formato
// { titulo, conteudo } que o iaAgent já espera na baseConhecimento.
export async function buscarChunksRelevantes({
  doctorId,
  pergunta,
  limiar = 0.4,
  maxChunks = 6,
  orcamentoTokens = 1500,
}) {
  if (!doctorId || !pergunta?.trim()) return [];

  const embedding = await gerarEmbedding(pergunta.trim(), 'query');

  const { data, error } = await supabase.rpc('match_knowledge_chunks', {
    query_embedding: paraLiteralVetor(embedding),
    p_doctor_id: doctorId,
    match_threshold: limiar,
    match_count: maxChunks,
  });
  if (error) throw new Error(`Erro na busca vetorial: ${error.message}`);

  const selecionados = [];
  let tokens = 0;
  for (const chunk of data || []) {
    const custo = estimarTokens(chunk.conteudo);
    if (tokens + custo > orcamentoTokens && selecionados.length > 0) break;
    selecionados.push({ titulo: chunk.titulo || 'Base de conhecimento', conteudo: chunk.conteudo });
    tokens += custo;
  }
  return selecionados;
}
