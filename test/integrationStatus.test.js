// Hotfix: "Primeiros passos" e "Integrações" divergiam sobre o mesmo médico
// porque cada tela calculava "conectado" com uma regra diferente (ou, no caso
// das plataformas de venda, nenhuma regra — status hardcoded). Este teste
// trava a fonte única de verdade em src/lib/integrationStatus.js.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeDb } from './helpers/mockSupabase.js';

let db;
import { vi } from 'vitest';
vi.mock('../src/lib/supabase.js', () => ({
  get supabase() {
    return db.client;
  },
}));

const { isWhatsappOperacional, gatewaysComWebhookRecebido } = await import('../src/lib/integrationStatus.js');

describe('isWhatsappOperacional', () => {
  const ORIGINAL = process.env.META_SYSTEM_USER_TOKEN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.META_SYSTEM_USER_TOKEN;
    else process.env.META_SYSTEM_USER_TOKEN = ORIGINAL;
  });

  it('external_id + token de sistema (sem token próprio) => NÃO operacional para o onboarding do cliente', () => {
    process.env.META_SYSTEM_USER_TOKEN = 'sys-token';
    expect(isWhatsappOperacional({ external_id: 'phone1', access_token: null, access_token_encrypted: null })).toBe(false);
  });

  it('external_id sem qualquer token (nem próprio, nem de sistema) => NÃO operacional', () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    expect(isWhatsappOperacional({ external_id: 'phone1', access_token: null, access_token_encrypted: null })).toBe(false);
  });

  it('token próprio sem external_id => NÃO operacional (external_id é parte da URL da Graph API)', () => {
    process.env.META_SYSTEM_USER_TOKEN = 'sys-token';
    expect(isWhatsappOperacional({ external_id: null, access_token: 'tok', access_token_encrypted: null })).toBe(false);
  });

  it('waba_id sozinho (sem external_id, sem nenhum token) => NÃO operacional', () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    expect(isWhatsappOperacional({ external_id: null, access_token: null, access_token_encrypted: null, waba_id: 'wid-123' })).toBe(false);
  });

  it('waba_id presente JUNTO com external_id, mas sem token nenhum => NÃO operacional (waba_id nunca conta)', () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    expect(isWhatsappOperacional({ external_id: 'phone1', waba_id: 'wid-123', access_token: null, access_token_encrypted: null })).toBe(false);
  });

  it('access_token_encrypted conta como token próprio (mesmo sem token de sistema)', () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    expect(isWhatsappOperacional({ external_id: 'phone1', access_token: null, access_token_encrypted: 'cipher-blob' })).toBe(true);
  });

  it('nenhum campo preenchido => NÃO operacional', () => {
    delete process.env.META_SYSTEM_USER_TOKEN;
    expect(isWhatsappOperacional({})).toBe(false);
    expect(isWhatsappOperacional(null)).toBe(false);
  });
});

describe('gatewaysComWebhookRecebido', () => {
  const DOC_A = '00000000-0000-4000-8000-00000000000a';
  const DOC_B = '00000000-0000-4000-8000-00000000000b';

  beforeEach(() => {
    db = makeDb({
      leads: [
        { id: 'lA1', doctor_id: DOC_A },
        { id: 'lB1', doctor_id: DOC_B },
      ],
      deals: [
        { id: 'dA1', lead_id: 'lA1' },
        { id: 'dB1', lead_id: 'lB1' },
      ],
      transactions: [
        // Status "pendente", não "pago" — ainda assim prova que o webhook chegou.
        { id: 't1', deal_id: 'dA1', gateway: 'kiwify', status: 'pendente' },
        { id: 't2', deal_id: 'dB1', gateway: 'hotmart', status: 'pago' },
      ],
    });
  });

  it('médico sem nenhum lead/transação => conjunto vazio ("aguardando primeiro webhook")', async () => {
    const dbVazio = makeDb({ leads: [] });
    db = dbVazio;
    const resultado = await gatewaysComWebhookRecebido('doctor-sem-nada');
    expect(resultado.size).toBe(0);
  });

  it('transação com status "pendente" (não só "pago") já conta como webhook recebido', async () => {
    const resultado = await gatewaysComWebhookRecebido(DOC_A);
    expect(resultado.has('kiwify')).toBe(true);
  });

  it('médico A nunca herda o gateway do médico B, e vice-versa', async () => {
    const resultadoA = await gatewaysComWebhookRecebido(DOC_A);
    expect(resultadoA.has('kiwify')).toBe(true);
    expect(resultadoA.has('hotmart')).toBe(false);

    const resultadoB = await gatewaysComWebhookRecebido(DOC_B);
    expect(resultadoB.has('hotmart')).toBe(true);
    expect(resultadoB.has('kiwify')).toBe(false);
  });
});
