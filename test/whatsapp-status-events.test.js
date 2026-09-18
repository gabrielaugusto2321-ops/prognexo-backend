import { describe, it, expect, vi } from 'vitest';
import { applyWhatsAppStatusEvent } from '../src/lib/whatsappStatusEvents.js';

function fakeSupabase(envio) {
  const updates = [];
  return {
    updates,
    client: {
      from(table) {
        expect(table).toBe('campanha_envios');
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: envio, error: null }),
          update(patch) {
            updates.push(patch);
            return { eq: async () => { Object.assign(envio, patch); return { data: null, error: null }; } };
          },
        };
      },
    },
  };
}

describe('applyWhatsAppStatusEvent — idempotência e monotonicidade', () => {
  it('sem message_id: ignorado, nunca 500, log sanitizado', async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const r = await applyWhatsAppStatusEvent({ supabase: {}, messageId: null, status: 'sent', log });
    expect(r).toEqual({ applied: false, reason: 'missing_message_id' });
    expect(log.warn).toHaveBeenCalledWith({ code: 'missing_message_id' }, expect.any(String));
  });

  it('status desconhecido é ignorado sem vazar o valor bruto no log', async () => {
    const log = { warn: vi.fn() };
    const r = await applyWhatsAppStatusEvent({ supabase: {}, messageId: 'wamid.1', status: 'esquisito', log });
    expect(r).toEqual({ applied: false, reason: 'unknown_status' });
    expect(log.warn).toHaveBeenCalledWith({ code: 'unknown_status' }, expect.any(String));
  });

  it('message_id não encontrado: log sanitizado, nunca erro', async () => {
    const { client } = fakeSupabase(null);
    const log = { warn: vi.fn() };
    const r = await applyWhatsAppStatusEvent({ supabase: client, messageId: 'wamid.inexistente', status: 'sent', log });
    expect(r).toEqual({ applied: false, reason: 'not_found' });
    expect(log.warn).toHaveBeenCalledWith({ code: 'message_id_not_found' }, expect.any(String));
  });

  it('transição monotônica: accepted -> sent -> delivered -> read', async () => {
    const envio = { id: 'e1', meta_status: 'accepted' };
    const { client, updates } = fakeSupabase(envio);
    await applyWhatsAppStatusEvent({ supabase: client, messageId: 'wamid.1', status: 'sent' });
    expect(envio.meta_status).toBe('sent');
    await applyWhatsAppStatusEvent({ supabase: client, messageId: 'wamid.1', status: 'delivered' });
    expect(envio.meta_status).toBe('delivered');
    await applyWhatsAppStatusEvent({ supabase: client, messageId: 'wamid.1', status: 'read' });
    expect(envio.meta_status).toBe('read');
    expect(updates).toHaveLength(3);
  });

  it('evento repetido (mesmo status) é ignorado, não gera update duplicado', async () => {
    const envio = { id: 'e1', meta_status: 'delivered' };
    const { client, updates } = fakeSupabase(envio);
    const r = await applyWhatsAppStatusEvent({ supabase: client, messageId: 'wamid.1', status: 'delivered' });
    expect(r).toEqual({ applied: false, reason: 'late_or_duplicate' });
    expect(updates).toHaveLength(0);
    expect(envio.meta_status).toBe('delivered');
  });

  it('evento atrasado nunca rebaixa read para delivered/sent', async () => {
    const envio = { id: 'e1', meta_status: 'read' };
    const { client, updates } = fakeSupabase(envio);
    const r1 = await applyWhatsAppStatusEvent({ supabase: client, messageId: 'wamid.1', status: 'delivered' });
    expect(r1).toEqual({ applied: false, reason: 'late_or_duplicate' });
    const r2 = await applyWhatsAppStatusEvent({ supabase: client, messageId: 'wamid.1', status: 'sent' });
    expect(r2).toEqual({ applied: false, reason: 'late_or_duplicate' });
    expect(updates).toHaveLength(0);
    expect(envio.meta_status).toBe('read');
  });

  it('failed é terminal: nada muda depois dele, mesmo um "read" tardio', async () => {
    const envio = { id: 'e1', meta_status: 'failed' };
    const { client, updates } = fakeSupabase(envio);
    const r = await applyWhatsAppStatusEvent({ supabase: client, messageId: 'wamid.1', status: 'read' });
    expect(r).toEqual({ applied: false, reason: 'terminal_failed' });
    expect(updates).toHaveLength(0);
  });

  it('failed tardio depois de read já visto não rebaixa (late_event_ignored)', async () => {
    const envio = { id: 'e1', meta_status: 'read' };
    const { client, updates } = fakeSupabase(envio);
    const r = await applyWhatsAppStatusEvent({ supabase: client, messageId: 'wamid.1', status: 'failed', errorCode: 131026 });
    expect(r).toEqual({ applied: false, reason: 'late_event_ignored' });
    expect(updates).toHaveLength(0);
    expect(envio.meta_status).toBe('read');
  });

  it('failed guarda só o código sanitizado, nunca a mensagem bruta', async () => {
    const envio = { id: 'e1', meta_status: 'sent' };
    const { client, updates } = fakeSupabase(envio);
    await applyWhatsAppStatusEvent({ supabase: client, messageId: 'wamid.1', status: 'failed', errorCode: 131026 });
    expect(updates[0]).toMatchObject({ meta_status: 'failed', meta_error_code: '131026' });
    expect(JSON.stringify(updates[0])).not.toMatch(/message|texto|phone/i);
  });
});
