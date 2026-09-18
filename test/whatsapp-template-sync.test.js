import { describe, it, expect, vi } from 'vitest';
process.env.NODE_ENV = 'test';
process.env.CORS_ALLOWED_ORIGINS = 'https://app.test';
vi.mock('../src/lib/supabase.js', () => ({ supabase: {} }));
const { fetchAllWhatsAppTemplates, syncWhatsAppTemplates } = await import('../src/lib/whatsappTemplateSync.js');

function page(items, next) {
  return {
    ok: true,
    json: async () => ({
      data: items,
      paging: next ? { cursors: { after: next }, next: `https://graph.facebook.com/x?after=${next}` } : { cursors: {} },
    }),
  };
}

describe('fetchAllWhatsAppTemplates — paginação segura', () => {
  it('percorre todas as páginas até paging.next ausente', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url) => {
      calls.push(url);
      if (calls.length === 1) return page([{ id: '1' }], 'cursorA');
      if (calls.length === 2) return page([{ id: '2' }], 'cursorB');
      return page([{ id: '3' }]);
    });
    const items = await fetchAllWhatsAppTemplates({ wabaId: 'waba-1', accessToken: 'tok', fetchImpl });
    expect(items.map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(calls).toHaveLength(3);
    // Sempre reconstrói a URL a partir do host fixo — nunca segue paging.next.
    for (const url of calls) {
      expect(url.startsWith('https://graph.facebook.com/')).toBe(true);
      expect(url).toContain('/waba-1/message_templates');
    }
    expect(calls[1]).toContain('after=cursorA');
    expect(calls[2]).toContain('after=cursorB');
  });

  it('nunca encaminha o token para outro host — Authorization vai sempre pro mesmo host fixo', async () => {
    const seenHeaders = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      seenHeaders.push({ url, auth: opts?.headers?.Authorization });
      return page([]);
    });
    await fetchAllWhatsAppTemplates({ wabaId: 'waba-1', accessToken: 'secret-tok', fetchImpl });
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0].url.startsWith('https://graph.facebook.com/')).toBe(true);
    expect(seenHeaders[0].auth).toBe('Bearer secret-tok');
  });

  it('detecta cursor repetido e lança, nunca entra em loop infinito', async () => {
    const fetchImpl = vi.fn(async () => page([{ id: '1' }], 'cursor-fixo')); // sempre devolve o MESMO cursor
    await expect(fetchAllWhatsAppTemplates({ wabaId: 'w', accessToken: 't', fetchImpl }))
      .rejects.toMatchObject({ code: 'template_sync_cursor_repeated' });
  });

  it('limite defensivo de páginas é respeitado', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => { n += 1; return page([{ id: String(n) }], `cursor-${n}`); }); // cursor sempre novo, nunca termina
    await expect(fetchAllWhatsAppTemplates({ wabaId: 'w', accessToken: 't', fetchImpl }))
      .rejects.toMatchObject({ code: 'template_sync_page_limit_exceeded' });
  });

  it('propaga erro da Meta sem mascarar', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({ error: { message: 'Invalid OAuth token', code: 190 } }) }));
    await expect(fetchAllWhatsAppTemplates({ wabaId: 'w', accessToken: 't', fetchImpl })).rejects.toThrow();
  });
});

describe('syncWhatsAppTemplates — orquestração completa', () => {
  it('bufferiza todas as páginas ANTES de chamar a RPC (só uma chamada, com o array completo)', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (!url.includes('after=')) return page([{ id: '1', name: 't1', status: 'APPROVED', language: 'pt_BR', components: [{ type: 'BODY', text: 'Oi' }] }], 'c1');
      return page([{ id: '2', name: 't2', status: 'PENDING', language: 'pt_BR', components: [{ type: 'BODY', text: 'Oi 2' }] }]);
    });
    const rpcCalls = [];
    const supabaseClient = { rpc: vi.fn(async (name, params) => { rpcCalls.push({ name, params }); return { data: { upserted: 2, deactivated: 0 }, error: null }; }) };

    const result = await syncWhatsAppTemplates({ doctorId: 'doc-1', organizationId: null, wabaId: 'waba-1', accessToken: 'tok', supabaseClient, fetchImpl });

    expect(rpcCalls).toHaveLength(1); // uma ÚNICA chamada, nunca por página
    expect(rpcCalls[0].name).toBe('whatsapp_templates_sync_replace');
    expect(rpcCalls[0].params.p_templates).toHaveLength(2);
    expect(rpcCalls[0].params.p_doctor_id).toBe('doc-1');
    expect(result.synced).toBe(2);
  });

  it('falha na página 2: nenhuma chamada de RPC acontece (cache nunca é tocado)', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) return page([{ id: '1', name: 't1', status: 'APPROVED', components: [{ type: 'BODY', text: 'Oi' }] }], 'c1');
      return { ok: false, json: async () => ({ error: { message: 'temporary failure' } }) };
    });
    const rpc = vi.fn();
    await expect(syncWhatsAppTemplates({ doctorId: 'doc-1', organizationId: null, wabaId: 'waba-1', accessToken: 'tok', supabaseClient: { rpc }, fetchImpl }))
      .rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
