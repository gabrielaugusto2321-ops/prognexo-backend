import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { normalizeBrazilianPhone } from './phoneNormalization.js';

export const MAX_BYTES = 2 * 1024 * 1024;
export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

export const REQUIRED_HEADERS = [
  'nome', 'telefone', 'origem', 'indicado_por', 'autorizacao_whatsapp', 'data_autorizacao',
];

export class LeadImportError extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export function detectCsvDelimiter(text) {
  const header = String(text).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] || '';
  const semicolons = (header.match(/;/g) || []).length;
  const commas = (header.match(/,/g) || []).length;
  return semicolons >= commas && semicolons > 0 ? ';' : ',';
}

function parseAuthorizationDate(value) {
  const raw = String(value ?? '').trim();
  let year; let month; let day;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) [, year, month, day] = match;
  else {
    match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
    if (match) [, day, month, year] = match;
  }
  if (!match) return null;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  if (date.getTime() > Date.now()) return null;
  return date.toISOString();
}

function normalizedAuthorization(value) {
  return String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function parseAndValidateLeadCsv(rawText) {
  const text = String(rawText ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new LeadImportError('arquivo_vazio');
  let records;
  try {
    records = parse(text, {
      columns: true, trim: true, skip_empty_lines: true, bom: true,
      delimiter: detectCsvDelimiter(text), relax_column_count: false,
      // Aborta o parser assim que existir a linha 5001 — nunca materializa um
      // arquivo com mais registros do que o limite permitido, mesmo dentro do
      // teto de 2MB (csv-parse suporta isso nativamente via `to`).
      to: 5001,
    });
  } catch {
    throw new LeadImportError('csv_invalido');
  }
  const headers = records.length > 0 ? Object.keys(records[0]) : parse(text.split(/\r?\n/, 1)[0], { delimiter: detectCsvDelimiter(text), bom: true })[0] || [];
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  const unexpected = headers.filter((h) => !REQUIRED_HEADERS.includes(h));
  if (missing.length || unexpected.length) throw new LeadImportError('cabecalho_invalido', { missing, unexpected });
  if (records.length > 5000) throw new LeadImportError('arquivo_excede_limite_linhas');

  const seen = new Set();
  return records.map((record, index) => {
    const row_number = index + 2;
    const nome = String(record.nome ?? '').trim();
    const phone = normalizeBrazilianPhone(record.telefone);
    const origem = String(record.origem ?? '').trim();
    const indicado_por = String(record.indicado_por ?? '').trim();
    const auth = normalizedAuthorization(record.autorizacao_whatsapp);
    let error_code = null;
    if (!nome || nome.length > 160) error_code = 'nome_obrigatorio';
    else if (!phone.valid) error_code = 'telefone_invalido';
    else if (origem.length > 200 || indicado_por.length > 200) error_code = 'campo_texto_invalido';
    else if (!['', 'sim', 'nao'].includes(auth)) error_code = 'autorizacao_valor_invalido';
    const authorizationAt = auth === 'sim' ? parseAuthorizationDate(record.data_autorizacao) : null;
    if (!error_code && auth === 'sim' && !authorizationAt) error_code = 'autorizacao_sem_data';
    let status = error_code ? 'invalido' : 'valido';
    // Só entra na detecção de duplicidade quem já está completamente válido —
    // uma linha invalida (nome ausente, etc.) nunca pode "reservar" o telefone
    // e fazer uma linha posterior, genuinamente válida, ser descartada como
    // falso duplicado (achado #3 da auditoria da FASE 1).
    if (status === 'valido') {
      if (seen.has(phone.canonical)) status = 'duplicado_arquivo';
      else seen.add(phone.canonical);
    }
    return {
      row_number, nome, telefone_original: String(record.telefone ?? '').trim(),
      telefone_normalizado: phone.canonical, origem, indicado_por,
      whatsapp_authorization_status: auth === 'sim' ? 'autorizado' : 'pendente',
      whatsapp_authorization_at: authorizationAt,
      whatsapp_authorization_source: auth === 'sim' ? 'csv_import' : null,
      status, error_code,
    };
  });
}

// Adapter used by the HTTP routes. It intentionally returns validation errors
// as data so malformed uploads stay ordinary 400 responses.
export async function processImportFile(rawBuffer, { fetchExistingPhoneMap } = {}) {
  if (!rawBuffer || rawBuffer.length === 0) return { error: 'arquivo_vazio' };
  if (rawBuffer.length > MAX_BYTES) return { error: 'arquivo_muito_grande' };
  let rows;
  try {
    rows = parseAndValidateLeadCsv(rawBuffer.toString('utf8'));
  } catch (err) {
    if (err instanceof LeadImportError) {
      return { error: err.code, missing: err.details?.missing, extra: err.details?.unexpected };
    }
    throw err;
  }
  const candidates = rows.filter((r) => r.status === 'valido').map((r) => r.telefone_normalizado);
  const existing = fetchExistingPhoneMap ? await fetchExistingPhoneMap([...new Set(candidates)]) : new Map();
  const linhas = rows.map((row) => {
    let status = row.status;
    const existingId = status === 'valido' ? existing.get(row.telefone_normalizado) : null;
    if (existingId) status = 'duplicado_existente';
    return {
      ...row,
      status,
      motivo: row.error_code,
      existing_lead_id: existingId || null,
      autorizacao_alvo: row.whatsapp_authorization_status,
      data_autorizacao_iso: row.whatsapp_authorization_at,
    };
  });
  const invalidas = linhas.filter((r) => r.status === 'invalido').length;
  const duplicadas_arquivo = linhas.filter((r) => r.status === 'duplicado_arquivo').length;
  const existentes_medico = linhas.filter((r) => r.status === 'duplicado_existente').length;
  const criar = linhas.filter((r) => r.status === 'valido').length;
  return {
    total: linhas.length,
    validas: criar + existentes_medico,
    invalidas,
    duplicadas_arquivo,
    existentes_medico,
    linhas,
    resumo: { criar, atualizar: existentes_medico, ignorar: invalidas + duplicadas_arquivo },
  };
}
