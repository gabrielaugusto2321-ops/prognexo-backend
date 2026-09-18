import { describe, it, expect } from 'vitest';
import {
  evaluateTemplateSupport, buildTemplateRow, isTemplateSelectable, isTemplateSyncFresh, isTemplateReadyToSend,
  validateTemplateVariableMap, buildTemplateSnapshot, renderTemplateBodyParameters,
  isPermanentTemplateError, sanitizeMetaErrorCode,
} from '../src/lib/whatsappTemplates.js';

const approvedBase = {
  id: 'meta-1', name: 'confirmacao', status: 'APPROVED', language: 'pt_BR', category: 'UTILITY',
  parameter_format: 'POSITIONAL',
  components: [{ type: 'BODY', text: 'Olá {{1}}, sua consulta é dia {{2}}.' }],
};

describe('evaluateTemplateSupport — regras MVP', () => {
  it('template simples com 2 parâmetros contíguos é suportado', () => {
    const r = evaluateTemplateSupport(approvedBase);
    expect(r.supported).toBe(true);
    expect(r.variableCount).toBe(2);
    expect(r.bodyText).toBe(approvedBase.components[0].text);
  });

  it('sem componente BODY textual é rejeitado', () => {
    const r = evaluateTemplateSupport({ ...approvedBase, components: [{ type: 'HEADER', format: 'TEXT', text: 'Oi' }] });
    expect(r.supported).toBe(false);
    expect(r.reason).toBe('sem_body_textual');
  });

  it('HEADER com mídia obrigatória é rejeitado', () => {
    const r = evaluateTemplateSupport({
      ...approvedBase,
      components: [{ type: 'HEADER', format: 'IMAGE' }, ...approvedBase.components],
    });
    expect(r.supported).toBe(false);
    expect(r.reason).toBe('midia_obrigatoria_no_header');
  });

  it('HEADER de texto com variável é rejeitado', () => {
    const r = evaluateTemplateSupport({
      ...approvedBase,
      components: [{ type: 'HEADER', format: 'TEXT', text: 'Olá {{1}}' }, ...approvedBase.components],
    });
    expect(r.supported).toBe(false);
    expect(r.reason).toBe('variavel_no_header');
  });

  it('parameter_format NAMED é rejeitado', () => {
    const r = evaluateTemplateSupport({ ...approvedBase, parameter_format: 'NAMED' });
    expect(r.supported).toBe(false);
    expect(r.reason).toBe('parametro_nomeado');
  });

  it('placeholder não-numérico no BODY é rejeitado mesmo sem parameter_format', () => {
    const r = evaluateTemplateSupport({
      ...approvedBase, parameter_format: undefined,
      components: [{ type: 'BODY', text: 'Olá {{nome}}' }],
    });
    expect(r.supported).toBe(false);
    expect(r.reason).toBe('parametro_nomeado');
  });

  it('parâmetros não contíguos (pula o {{2}}) são rejeitados', () => {
    const r = evaluateTemplateSupport({ ...approvedBase, components: [{ type: 'BODY', text: 'Olá {{1}} {{3}}' }] });
    expect(r.supported).toBe(false);
    expect(r.reason).toBe('parametros_nao_contiguos');
  });

  it('botão com variável dinâmica na URL é rejeitado', () => {
    const r = evaluateTemplateSupport({
      ...approvedBase,
      components: [...approvedBase.components, { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.com/{{1}}' }] }],
    });
    expect(r.supported).toBe(false);
    expect(r.reason).toBe('variavel_em_botao');
  });

  it('botão estático (sem variável) não bloqueia suporte', () => {
    const r = evaluateTemplateSupport({
      ...approvedBase,
      components: [...approvedBase.components, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirmar' }] }],
    });
    expect(r.supported).toBe(true);
  });

  it('template sem nenhuma variável (0 parâmetros) é suportado', () => {
    const r = evaluateTemplateSupport({ ...approvedBase, components: [{ type: 'BODY', text: 'Olá, tudo bem?' }] });
    expect(r.supported).toBe(true);
    expect(r.variableCount).toBe(0);
  });
});

describe('buildTemplateRow', () => {
  it('converte um item cru da Meta em linha do cache, nunca incluindo campos fora do schema', () => {
    const row = buildTemplateRow(approvedBase);
    expect(row).toMatchObject({
      meta_template_id: 'meta-1', nome: 'confirmacao', idioma: 'pt_BR', categoria: 'UTILITY',
      status: 'APPROVED', supported: true, body_variable_count: 2,
    });
    expect(row.componentes).toEqual(approvedBase.components);
  });
});

describe('isTemplateSelectable / isTemplateSyncFresh / isTemplateReadyToSend', () => {
  const fresh = { active: true, supported: true, status: 'APPROVED', last_synced_at: new Date().toISOString() };
  it('selecionável exige active+supported+APPROVED', () => {
    expect(isTemplateSelectable(fresh)).toBe(true);
    expect(isTemplateSelectable({ ...fresh, active: false })).toBe(false);
    expect(isTemplateSelectable({ ...fresh, supported: false })).toBe(false);
    expect(isTemplateSelectable({ ...fresh, status: 'PENDING' })).toBe(false);
  });
  it('sync antigo (>24h) não é fresco', () => {
    const old = { last_synced_at: new Date(Date.now() - 25 * 3600_000).toISOString() };
    expect(isTemplateSyncFresh(old)).toBe(false);
    expect(isTemplateSyncFresh(fresh)).toBe(true);
  });
  it('pronto para envio exige selecionável + sync fresco', () => {
    expect(isTemplateReadyToSend(fresh)).toBe(true);
    expect(isTemplateReadyToSend({ ...fresh, last_synced_at: new Date(Date.now() - 25 * 3600_000).toISOString() })).toBe(false);
    expect(isTemplateReadyToSend({ ...fresh, active: false })).toBe(false);
  });
});

describe('validateTemplateVariableMap', () => {
  it('0 variáveis: mapa vazio/ausente é válido', () => {
    expect(validateTemplateVariableMap(0, null).ok).toBe(true);
    expect(validateTemplateVariableMap(0, {}).ok).toBe(true);
  });
  it('0 variáveis: mapa não esperado é rejeitado', () => {
    expect(validateTemplateVariableMap(0, { 1: { source: 'fixo', value: 'x' } }).ok).toBe(false);
  });
  it('quantidade errada é rejeitada', () => {
    expect(validateTemplateVariableMap(2, { 1: { source: 'lead_nome' } }).ok).toBe(false);
  });
  it('fonte inválida é rejeitada', () => {
    expect(validateTemplateVariableMap(1, { 1: { source: 'email_do_lead' } }).ok).toBe(false);
  });
  it('fixo vazio, não-string, muito longo ou com HTML é rejeitado', () => {
    expect(validateTemplateVariableMap(1, { 1: { source: 'fixo', value: '' } }).ok).toBe(false);
    expect(validateTemplateVariableMap(1, { 1: { source: 'fixo', value: 42 } }).ok).toBe(false);
    expect(validateTemplateVariableMap(1, { 1: { source: 'fixo', value: 'a'.repeat(400) } }).ok).toBe(false);
    expect(validateTemplateVariableMap(1, { 1: { source: 'fixo', value: '<script>x</script>' } }).ok).toBe(false);
  });
  it('mapa válido com as 3 fontes permitidas', () => {
    const r = validateTemplateVariableMap(3, {
      1: { source: 'lead_nome' }, 2: { source: 'doctor_nome' }, 3: { source: 'fixo', value: 'Clínica X' },
    });
    expect(r.ok).toBe(true);
  });
});

describe('buildTemplateSnapshot / renderTemplateBodyParameters', () => {
  const template = { meta_template_id: 'mt1', nome: 'confirmacao', idioma: 'pt_BR', categoria: 'UTILITY', body_text: 'Olá {{1}}', body_variable_count: 1 };
  it('congela os campos certos no snapshot', () => {
    const map = { 1: { source: 'lead_nome' } };
    expect(buildTemplateSnapshot(template, map)).toEqual({
      meta_template_id: 'mt1', nome: 'confirmacao', idioma: 'pt_BR', categoria: 'UTILITY',
      body_text: 'Olá {{1}}', body_variable_count: 1, variable_map: map,
    });
  });
  it('renderiza parâmetros na ordem certa a partir das 3 fontes', () => {
    const params = renderTemplateBodyParameters(3, {
      1: { source: 'lead_nome' }, 2: { source: 'doctor_nome' }, 3: { source: 'fixo', value: 'Consultório Central' },
    }, { leadNome: 'Maria', doctorNome: 'Dr. João' });
    expect(params).toEqual([
      { type: 'text', text: 'Maria' }, { type: 'text', text: 'Dr. João' }, { type: 'text', text: 'Consultório Central' },
    ]);
  });
});

describe('erros de template', () => {
  it('132001 e outros códigos permanentes são reconhecidos', () => {
    expect(isPermanentTemplateError(132001)).toBe(true);
    expect(isPermanentTemplateError('132001')).toBe(true);
    expect(isPermanentTemplateError(4)).toBe(false); // rate limit — não é permanente
  });
  it('sanitiza o código do erro, nunca a mensagem', () => {
    expect(sanitizeMetaErrorCode({ code: 132001, message: 'texto com telefone 5511999999999' })).toBe('132001');
    expect(sanitizeMetaErrorCode({})).toBe('unknown');
  });
});
