// Hotfix: JSON.parse falhava quando a IA cercava a resposta em markdown
// (```json ... ```) ou incluía texto antes/depois do objeto — a conversa
// inteira vazava pro lead como texto cru, e score/status caíam no fallback
// genérico. Este teste exercita processarMensagemComIA de verdade (só o
// fetch pra Anthropic é mockado), pra travar a normalização.
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.ANTHROPIC_API_KEY = 'test-key';

const { processarMensagemComIA } = await import('../src/lib/iaAgent.js');

function mockAnthropicText(texto) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ text: texto }] }),
  }));
}

const HISTORICO = [{ direcao: 'recebida', conteudo: 'Oi, tenho interesse' }];

const RESPOSTA_JSON = {
  resposta: 'Oi! Que legal! 😊 Como posso te ajudar? Qual é seu interesse?',
  status: 'qualificando',
  score: 10,
  sentimento_negativo: false,
  sem_resposta: false,
  dados_extraidos: {},
};

describe('processarMensagemComIA — normalização da resposta da IA', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('JSON puro: parseia normalmente (baseline de regressão)', async () => {
    mockAnthropicText(JSON.stringify(RESPOSTA_JSON));
    const resultado = await processarMensagemComIA({ historico: HISTORICO });
    expect(resultado.resposta).toBe(RESPOSTA_JSON.resposta);
    expect(resultado.status).toBe('qualificando');
    expect(resultado.score).toBe(10);
  });

  it('JSON cercado por ```json ... ```: parseia e não vaza a cerca pro lead', async () => {
    mockAnthropicText('```json\n' + JSON.stringify(RESPOSTA_JSON, null, 2) + '\n```');
    const resultado = await processarMensagemComIA({ historico: HISTORICO });
    expect(resultado.resposta).toBe(RESPOSTA_JSON.resposta);
    expect(resultado.status).toBe('qualificando');
    expect(resultado.score).toBe(10);
    expect(resultado.resposta).not.toContain('```');
  });

  it('JSON cercado por ``` ... ``` sem identificador de linguagem: parseia normalmente', async () => {
    mockAnthropicText('```\n' + JSON.stringify(RESPOSTA_JSON) + '\n```');
    const resultado = await processarMensagemComIA({ historico: HISTORICO });
    expect(resultado.resposta).toBe(RESPOSTA_JSON.resposta);
    expect(resultado.score).toBe(10);
  });

  it('texto antes/depois do objeto JSON: parseia normalmente', async () => {
    mockAnthropicText(`Aqui está minha resposta:\n${JSON.stringify(RESPOSTA_JSON)}\nEspero que ajude!`);
    const resultado = await processarMensagemComIA({ historico: HISTORICO });
    expect(resultado.resposta).toBe(RESPOSTA_JSON.resposta);
    expect(resultado.score).toBe(10);
  });

  it('score numérico igual a 0: continua 0, nunca null nem cai no fallback', async () => {
    mockAnthropicText(JSON.stringify({ ...RESPOSTA_JSON, score: 0 }));
    const resultado = await processarMensagemComIA({ historico: HISTORICO });
    expect(resultado.score).toBe(0);
    expect(resultado.status).toBe('qualificando');
  });

  it('JSON malformado/truncado: cai no fallback seguro atual (comportamento preservado)', async () => {
    const bruto = '```json\n{ "resposta": "Oi! Tudo bem?", "status": "qualifi';
    mockAnthropicText(bruto);
    const resultado = await processarMensagemComIA({ historico: HISTORICO });
    expect(resultado.score).toBeNull();
    expect(resultado.status).toBe('qualificando');
    expect(resultado.motivoHandoff).toBeNull();
    // Fallback usa o textoBruto ORIGINAL (com a cerca), não a versão normalizada.
    expect(resultado.resposta).toBe(bruto);
  });
});
