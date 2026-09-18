// FASE 2 — regras de suporte MVP, validação de variáveis e montagem do
// payload de templates aprovados da Meta. Nenhuma função aqui fala com a
// rede — só transforma dados já obtidos (sync) ou já validados (envio).

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function extractPlaceholders(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;
  const re = new RegExp(PLACEHOLDER_RE);
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

const isPositionalToken = (token) => /^\d+$/.test(token);

// Regras do MVP (nunca alteradas fora desta função — é o único lugar que
// decide `supported`):
//   - exatamente um componente BODY com texto;
//   - nenhuma variável no HEADER (texto ou mídia obrigatória);
//   - parameter_format != NAMED e nenhum placeholder não-numérico no BODY;
//   - placeholders posicionais contíguos (1..N, sem buraco/duplicata);
//   - nenhuma variável dinâmica em botão.
export function evaluateTemplateSupport(rawTemplate) {
  const components = Array.isArray(rawTemplate?.components) ? rawTemplate.components : [];
  const headers = components.filter((c) => c?.type === 'HEADER');
  const bodies = components.filter((c) => c?.type === 'BODY');
  const buttonsComp = components.find((c) => c?.type === 'BUTTONS');

  if (bodies.length !== 1 || typeof bodies[0]?.text !== 'string' || !bodies[0].text.trim()) {
    return { supported: false, reason: 'sem_body_textual', bodyText: null, variableCount: 0 };
  }
  const bodyText = bodies[0].text;

  for (const header of headers) {
    if (header.format && header.format !== 'TEXT') {
      return { supported: false, reason: 'midia_obrigatoria_no_header', bodyText, variableCount: 0 };
    }
    if (extractPlaceholders(header.text).length > 0) {
      return { supported: false, reason: 'variavel_no_header', bodyText, variableCount: 0 };
    }
  }

  if (rawTemplate?.parameter_format && String(rawTemplate.parameter_format).toUpperCase() === 'NAMED') {
    return { supported: false, reason: 'parametro_nomeado', bodyText, variableCount: 0 };
  }

  const tokens = extractPlaceholders(bodyText);
  if (tokens.some((t) => !isPositionalToken(t))) {
    return { supported: false, reason: 'parametro_nomeado', bodyText, variableCount: 0 };
  }

  const positions = [...new Set(tokens.map(Number))].sort((a, b) => a - b);
  for (let i = 0; i < positions.length; i += 1) {
    if (positions[i] !== i + 1) {
      return { supported: false, reason: 'parametros_nao_contiguos', bodyText, variableCount: positions.length };
    }
  }

  if (buttonsComp) {
    const hasDynamicButton = (buttonsComp.buttons || []).some((b) =>
      extractPlaceholders(b?.url).length > 0 || extractPlaceholders(b?.text).length > 0
    );
    if (hasDynamicButton) {
      return { supported: false, reason: 'variavel_em_botao', bodyText, variableCount: positions.length };
    }
  }

  return { supported: true, reason: null, bodyText, variableCount: positions.length };
}

// Converte um item cru de GET /{waba_id}/message_templates no formato de
// linha de `whatsapp_templates`. Nunca inclui token/dado de rede — só os
// campos já documentados no schema.
export function buildTemplateRow(rawTemplate) {
  const evaluated = evaluateTemplateSupport(rawTemplate);
  return {
    meta_template_id: String(rawTemplate?.id ?? ''),
    nome: rawTemplate?.name ?? null,
    idioma: rawTemplate?.language ?? null,
    categoria: rawTemplate?.category ?? null,
    status: rawTemplate?.status ?? null,
    parameter_format: rawTemplate?.parameter_format ?? null,
    componentes: Array.isArray(rawTemplate?.components) ? rawTemplate.components : [],
    body_text: evaluated.bodyText,
    body_variable_count: evaluated.variableCount,
    supported: evaluated.supported,
    unsupported_reason: evaluated.reason,
  };
}

// Selecionável no MVP: aprovado pela Meta, presente na última sincronização
// completa, e estruturalmente suportado.
export function isTemplateSelectable(template) {
  return Boolean(template) && template.active === true && template.supported === true && template.status === 'APPROVED';
}

// Mesmo teto usado pelo frontend para bloquear a criação de campanha por
// template quando o cache está desatualizado (ver ARQUITETURA no relatório).
export const TEMPLATE_SYNC_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export function isTemplateSyncFresh(template, now = Date.now()) {
  if (!template?.last_synced_at) return false;
  const age = now - new Date(template.last_synced_at).getTime();
  return Number.isFinite(age) && age >= 0 && age < TEMPLATE_SYNC_FRESHNESS_MS;
}

// Revalidação completa exigida IMEDIATAMENTE antes do envio, mesmo com
// template_snapshot já gravado na campanha — o snapshot é só auditoria,
// nunca autoriza envio sozinho.
export function isTemplateReadyToSend(template, now = Date.now()) {
  return isTemplateSelectable(template) && isTemplateSyncFresh(template, now);
}

export const TEMPLATE_VARIABLE_SOURCES = new Set(['lead_nome', 'doctor_nome', 'fixo']);
export const TEMPLATE_FIXED_VALUE_MAX_LENGTH = 300;

// Valida `template_variable_map` contra a contagem de variáveis do BODY.
// Nunca aceita objeto/HTML em "fixo" — só string simples, não vazia, com
// limite de tamanho seguro.
export function validateTemplateVariableMap(variableCount, variableMap) {
  if (!variableCount) {
    if (variableMap && Object.keys(variableMap).length > 0) return { ok: false, reason: 'mapa_nao_esperado' };
    return { ok: true };
  }
  if (!variableMap || typeof variableMap !== 'object' || Array.isArray(variableMap)) {
    return { ok: false, reason: 'mapa_obrigatorio' };
  }
  const keys = Object.keys(variableMap);
  if (keys.length !== variableCount) return { ok: false, reason: 'quantidade_incorreta' };

  for (let i = 1; i <= variableCount; i += 1) {
    const entry = variableMap[String(i)];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { ok: false, reason: 'posicao_ausente' };
    if (!TEMPLATE_VARIABLE_SOURCES.has(entry.source)) return { ok: false, reason: 'fonte_invalida' };
    if (entry.source === 'fixo') {
      if (typeof entry.value !== 'string') return { ok: false, reason: 'valor_fixo_deve_ser_string' };
      const trimmed = entry.value.trim();
      if (!trimmed) return { ok: false, reason: 'valor_fixo_vazio' };
      if (trimmed.length > TEMPLATE_FIXED_VALUE_MAX_LENGTH) return { ok: false, reason: 'valor_fixo_muito_longo' };
      if (/[<>]/.test(trimmed)) return { ok: false, reason: 'valor_fixo_invalido' };
    }
  }
  return { ok: true };
}

// Congela os dados do template no momento da criação da campanha. Nunca
// usado para AUTORIZAR o envio — só auditoria/exibição (ver ENVIO META).
export function buildTemplateSnapshot(template, variableMap) {
  return {
    meta_template_id: template.meta_template_id,
    nome: template.nome,
    idioma: template.idioma,
    categoria: template.categoria,
    body_text: template.body_text,
    body_variable_count: template.body_variable_count,
    variable_map: variableMap,
  };
}

// Resolve os valores finais (ordem 1..N) a partir do mapa validado + dados
// do destinatário/médico. Retorna o array `parameters` pronto para o
// componente BODY do payload da Meta.
export function renderTemplateBodyParameters(variableCount, variableMap, { leadNome, doctorNome }) {
  const parameters = [];
  for (let i = 1; i <= variableCount; i += 1) {
    const entry = variableMap[String(i)];
    let text;
    if (entry.source === 'lead_nome') text = leadNome || '';
    else if (entry.source === 'doctor_nome') text = doctorNome || '';
    else text = entry.value;
    parameters.push({ type: 'text', text: String(text) });
  }
  return parameters;
}

// Códigos de erro da Meta para template que são PERMANENTES (nunca retry):
// template não existe/foi pausado/desabilitado, ou o número/ordem de
// parâmetros enviados não bate com o aprovado (132001).
export const PERMANENT_TEMPLATE_ERROR_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);

export function isPermanentTemplateError(metaErrorCode) {
  return PERMANENT_TEMPLATE_ERROR_CODES.has(Number(metaErrorCode));
}

// Nunca deixa a mensagem crua da Meta (pode conter parte do payload) chegar
// ao ledger — só um código numérico estável, quando existir.
export function sanitizeMetaErrorCode(metaError) {
  const code = metaError?.code;
  return Number.isFinite(Number(code)) ? String(Number(code)) : 'unknown';
}
