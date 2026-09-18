import { env } from '../config/env.js';
import { supabase } from './supabase.js';
import { rpcOrThrow } from './jobQueue.js';
import { buildTemplateRow } from './whatsappTemplates.js';

// Host fixo — NUNCA construído a partir de dado devolvido pela Meta
// (`paging.next` é ignorado propositalmente; só o cursor `after` é
// reaproveitado). Isso garante que o token de acesso nunca é encaminhado
// para um host diferente do esperado, mesmo que a resposta da Meta seja
// adulterada ou aponte para outro domínio.
const GRAPH_HOST = 'https://graph.facebook.com';
const PAGE_LIMIT = 100;
// Limites defensivos — uma WABA real tem no máximo algumas centenas de
// templates; isso é só um teto de segurança contra paginação infinita/hostil.
const MAX_PAGES = 50;
const MAX_TEMPLATES = 5000;

// Percorre TODAS as páginas de GET /{waba_id}/message_templates e devolve o
// array completo — nunca escreve no banco (isso é responsabilidade de
// `syncWhatsAppTemplates`, que só chama a RPC depois que o buffer inteiro
// está pronto).
export async function fetchAllWhatsAppTemplates({ wabaId, accessToken, fetchImpl = fetch }) {
  const fields = 'id,name,status,language,category,parameter_format,components';
  let after = null;
  let page = 0;
  const seenCursors = new Set();
  const all = [];

  for (;;) {
    page += 1;
    if (page > MAX_PAGES) {
      throw Object.assign(new Error('template_sync_page_limit_exceeded'), { code: 'template_sync_page_limit_exceeded' });
    }

    const params = new URLSearchParams({ fields, limit: String(PAGE_LIMIT) });
    if (after) params.set('after', after);
    const url = `${GRAPH_HOST}/${env.META_GRAPH_API_VERSION}/${wabaId}/message_templates?${params.toString()}`;

    const resp = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await resp.json();
    if (!resp.ok) {
      const erro = new Error(data?.error?.message || 'Erro ao listar templates do WhatsApp');
      erro.metaError = data?.error;
      throw erro;
    }

    const items = Array.isArray(data?.data) ? data.data : [];
    all.push(...items);
    if (all.length > MAX_TEMPLATES) {
      throw Object.assign(new Error('template_sync_item_limit_exceeded'), { code: 'template_sync_item_limit_exceeded' });
    }

    const nextAfter = data?.paging?.cursors?.after ?? null;
    const hasNext = Boolean(data?.paging?.next) && Boolean(nextAfter);
    if (!hasNext) break;
    if (seenCursors.has(nextAfter)) {
      throw Object.assign(new Error('template_sync_cursor_repeated'), { code: 'template_sync_cursor_repeated' });
    }
    seenCursors.add(nextAfter);
    after = nextAfter;
  }

  return all;
}

// Orquestra o sync completo de um médico: pagina tudo, transforma em linhas
// (`buildTemplateRow` decide `supported`/`body_variable_count`), e só então
// chama a RPC transacional que substitui o snapshot inteiro de uma vez.
export async function syncWhatsAppTemplates({
  doctorId, organizationId, wabaId, accessToken, supabaseClient = supabase, fetchImpl = fetch,
}) {
  const rawTemplates = await fetchAllWhatsAppTemplates({ wabaId, accessToken, fetchImpl });
  const rows = rawTemplates.map(buildTemplateRow);
  const result = await rpcOrThrow(supabaseClient, 'whatsapp_templates_sync_replace', {
    p_doctor_id: doctorId,
    p_organization_id: organizationId,
    p_templates: rows,
  });
  return { ...result, synced: rows.length };
}
