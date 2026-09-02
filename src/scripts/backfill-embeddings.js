// Backfill: gera os embeddings dos itens que já existem na knowledge_base.
//
// Uso:
//   node src/scripts/backfill-embeddings.js               (todos os itens)
//   node src/scripts/backfill-embeddings.js <doctor_id>   (só um médico)
//
// Precisa de SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e VOYAGE_API_KEY no
// ambiente (o .env já é carregado via lib/supabase.js).

import { supabase } from '../lib/supabase.js';
import { reindexarKnowledgeBaseItem } from '../lib/knowledgeChunks.js';

const doctorId = process.argv[2] || null;

let query = supabase
  .from('knowledge_base')
  .select('id, doctor_id, titulo, conteudo')
  .order('criado_em', { ascending: true });
if (doctorId) query = query.eq('doctor_id', doctorId);

const { data: itens, error } = await query;
if (error) {
  console.error('Erro ao listar knowledge_base:', error.message);
  process.exit(1);
}

console.log(`${itens.length} item(ns) para reindexar${doctorId ? ` (médico ${doctorId})` : ''}.`);

let ok = 0;
let falhas = 0;
for (const item of itens) {
  try {
    const { chunks } = await reindexarKnowledgeBaseItem(item);
    ok++;
    console.log(` ✓ ${item.titulo} — ${chunks} chunk(s)`);
  } catch (err) {
    falhas++;
    console.error(` ✗ ${item.titulo} (${item.id}): ${err.message}`);
  }
  // Respeito básico ao rate limit da Voyage.
  await new Promise((r) => setTimeout(r, 300));
}

console.log(`\nConcluído: ${ok} ok, ${falhas} falha(s).`);
process.exit(falhas > 0 ? 1 : 0);
