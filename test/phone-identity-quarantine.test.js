import { describe, it, expect, beforeEach } from 'vitest';
import { makeDb } from './helpers/mockSupabase.js';
import { resolveQuarantineLead } from '../src/lib/phoneIdentityQuarantine.js';

const SELECT = 'id, doctor_id, whatsapp_wa_id, telefone_normalizado, whatsapp_authorization_status, dados_extraidos';
const DOC_A = '00000000-0000-4000-9000-0000000000da';
const DOC_B = '00000000-0000-4000-9000-0000000000db';

let db;
beforeEach(() => {
  db = makeDb({ leads: [], deals: [] });
});

describe('resolveQuarantineLead', () => {
  it('cria o lead de quarentena quando não existe nenhum', async () => {
    const { lead, created } = await resolveQuarantineLead({
      supabase: db.client, doctorId: DOC_A, organizationId: null,
      rawDigits: '554300000001', telefoneOriginal: '554300000001', nome: 'Lead X', select: SELECT,
    });
    expect(created).toBe(true);
    expect(lead.doctor_id).toBe(DOC_A);
    expect(lead.whatsapp_wa_id).toBe('554300000001');
    expect(lead.telefone_normalizado).toBeNull();
    expect(lead.whatsapp_authorization_status).toBe('pendente');
    expect(lead.dados_extraidos).toMatchObject({ phone_identity_review_required: true, phone_identity_reason: 'ambiguous_candidates' });
  });

  it('reaproveita o lead de quarentena já existente (não cria um segundo)', async () => {
    const first = await resolveQuarantineLead({
      supabase: db.client, doctorId: DOC_A, organizationId: null,
      rawDigits: '554300000002', telefoneOriginal: '554300000002', nome: 'Lead Y', select: SELECT,
    });
    const second = await resolveQuarantineLead({
      supabase: db.client, doctorId: DOC_A, organizationId: null,
      rawDigits: '554300000002', telefoneOriginal: '554300000002', nome: 'Lead Y', select: SELECT,
    });
    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id);
    expect(db.tables.leads).toHaveLength(1);
  });

  it('corrida concorrente (23505 no insert): a segunda chamada nunca falha, reaproveita o lead da primeira, nunca duplica', async () => {
    // Simula duas mensagens concorrentes do MESMO wa_id: nenhuma das duas
    // encontra um lead na busca inicial (a primeira ainda não commitou), as
    // duas tentam inserir; a segunda tentativa de insert real (mock) já vê a
    // primeira e retorna 23505 — cenário coberto pelo mock de unicidade
    // parcial (doctor_id, whatsapp_wa_id) em mockSupabase.js.
    const [r1, r2] = await Promise.all([
      resolveQuarantineLead({
        supabase: db.client, doctorId: DOC_A, organizationId: null,
        rawDigits: '554300000003', telefoneOriginal: '554300000003', nome: 'Concorrente 1', select: SELECT,
      }),
      resolveQuarantineLead({
        supabase: db.client, doctorId: DOC_A, organizationId: null,
        rawDigits: '554300000003', telefoneOriginal: '554300000003', nome: 'Concorrente 2', select: SELECT,
      }),
    ]);
    expect(db.tables.leads).toHaveLength(1); // nunca duplica
    expect(r1.lead.id).toBe(r2.lead.id); // as duas chamadas resolveram pro MESMO lead
    expect([r1.created, r2.created].filter(Boolean)).toHaveLength(1); // exatamente uma criou, a outra reaproveitou
  });

  it('mesmo wa_id em médicos diferentes cria quarentenas SEPARADAS (nunca cruza doctor_id)', async () => {
    const a = await resolveQuarantineLead({
      supabase: db.client, doctorId: DOC_A, organizationId: null,
      rawDigits: '554300000004', telefoneOriginal: '554300000004', nome: 'Lead A', select: SELECT,
    });
    const b = await resolveQuarantineLead({
      supabase: db.client, doctorId: DOC_B, organizationId: null,
      rawDigits: '554300000004', telefoneOriginal: '554300000004', nome: 'Lead B', select: SELECT,
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.lead.id).not.toBe(b.lead.id);
    expect(db.tables.leads).toHaveLength(2);
  });

  it('violação 23505 seguida de busca sem resultado falha de forma explícita e sanitizada (nunca segue sem lead)', async () => {
    const supabaseFake = {
      from(table) {
        if (table !== 'leads') return db.client.from(table);
        let mode = 'select';
        const q = {
          select: () => q,
          eq: () => q,
          insert: () => { mode = 'insert'; return q; },
          maybeSingle: async () => (mode === 'select' ? { data: null, error: null } : undefined),
          single: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "leads_doctor_whatsapp_wa_id_key"' } }),
        };
        return q;
      },
    };
    await expect(resolveQuarantineLead({
      supabase: supabaseFake, doctorId: DOC_A, organizationId: null,
      rawDigits: '554300000005', telefoneOriginal: '554300000005', nome: 'X', select: SELECT,
    })).rejects.toMatchObject({ code: 'quarantine_lead_unresolved' });
  });

  it('erro de insert que NÃO é 23505 nunca vaza mensagem do banco (fica só o código sanitizado)', async () => {
    const supabaseFake = {
      from(table) {
        if (table !== 'leads') return db.client.from(table);
        let mode = 'select';
        const q = {
          select: () => q,
          eq: () => q,
          insert: () => { mode = 'insert'; return q; },
          maybeSingle: async () => (mode === 'select' ? { data: null, error: null } : undefined),
          single: async () => ({ data: null, error: { code: 'db_down', message: 'connection refused at 10.0.0.5 phone=554300000006' } }),
        };
        return q;
      },
    };
    let caught;
    try {
      await resolveQuarantineLead({
        supabase: supabaseFake, doctorId: DOC_A, organizationId: null,
        rawDigits: '554300000006', telefoneOriginal: '554300000006', nome: 'X', select: SELECT,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught.code).toBe('quarantine_lead_insert_failed');
    expect(caught.message).not.toContain('554300000006'); // nunca o telefone da mensagem de erro do banco
    expect(caught.message).not.toContain('connection refused');
  });
});
