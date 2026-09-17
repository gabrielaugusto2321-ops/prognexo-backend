// Lista oficial de DDDs brasileiros em uso (ANATEL). Usada só para rejeitar
// prefixos claramente inexistentes (ex.: "00", "10", "20") — nunca para
// inventar ou remover o nono dígito do celular.
const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

function invalid(reason, rawDigits) {
  return { valid: false, canonical: null, national: null, rawDigits, kind: null, hadLegacyMobileFormat: false, reason };
}

// Identidade de telefone brasileiro. Só entende BR (DDI 55) — qualquer
// entrada que não caiba nos formatos abaixo é rejeitada, nunca "adivinhada".
//
// Formatos aceitos na ENTRADA:
//   - nacional sem DDI: 10 dígitos (fixo) ou 11 dígitos (celular, com o 9)
//   - E.164 brasileiro: 12 dígitos (fixo, "55" + 10) ou 13 dígitos (celular, "55" + 11)
//
// Regra do nono dígito (NUNCA inserida às cegas):
//   - assinante de 9 dígitos: precisa começar em "9" — celular já completo,
//     devolvido exatamente como veio (hadLegacyMobileFormat=false).
//   - assinante de 8 dígitos começando em 2-5: fixo legítimo — o 9 NUNCA é
//     inserido (hadLegacyMobileFormat=false, kind='landline').
//   - assinante de 8 dígitos começando em 6-9: variante legada de celular
//     sem o nono dígito (o formato que a Meta pode entregar no webhook para
//     números brasileiros) — o 9 é inserido de forma determinística
//     (hadLegacyMobileFormat=true, kind='mobile'). O valor original (sem o 9)
//     deve ser preservado pelo chamador como alias/whatsapp_wa_id, nunca
//     descartado.
//   - qualquer outro prefixo de assinante (0/1) é rejeitado — não é DDD
//     válido nem celular nem fixo reconhecível.
export function normalizeBrazilianPhone(raw) {
  const rawDigits = String(raw ?? '').replace(/\D/g, '');

  let nacional = null;
  if (rawDigits.length === 10 || rawDigits.length === 11) {
    nacional = rawDigits;
  } else if ((rawDigits.length === 12 || rawDigits.length === 13) && rawDigits.startsWith('55')) {
    nacional = rawDigits.slice(2);
  } else {
    return invalid('comprimento_invalido', rawDigits);
  }

  const ddd = Number(nacional.slice(0, 2));
  if (!DDDS_VALIDOS.has(ddd)) {
    return invalid('ddd_invalido', rawDigits);
  }

  const assinante = nacional.slice(2);
  let kind = null;
  let hadLegacyMobileFormat = false;
  let nacionalCanonico = null;

  if (assinante.length === 9) {
    if (assinante[0] !== '9') return invalid('celular_invalido', rawDigits);
    kind = 'mobile';
    nacionalCanonico = nacional;
  } else if (assinante.length === 8) {
    const primeiro = assinante[0];
    if (primeiro >= '2' && primeiro <= '5') {
      kind = 'landline';
      nacionalCanonico = nacional; // fixo — nunca ganha o nono dígito
    } else if (primeiro >= '6' && primeiro <= '9') {
      kind = 'mobile';
      hadLegacyMobileFormat = true;
      nacionalCanonico = `${nacional.slice(0, 2)}9${assinante}`; // insere o 9 de forma determinística
    } else {
      return invalid('assinante_invalido', rawDigits);
    }
  } else {
    return invalid('comprimento_invalido', rawDigits);
  }

  return {
    valid: true,
    canonical: `55${nacionalCanonico}`,
    national: nacionalCanonico,
    rawDigits,
    kind,
    hadLegacyMobileFormat,
    reason: null,
  };
}

// Resolve o telefone canônico (E.164, só dígitos) usado para ENVIO, a partir
// de um lead. Nunca escreve no banco — é só leitura/derivação, pura.
//   1. telefone_normalizado, se já é um canônico válido (fonte de verdade);
//   2. senão, tenta normalizar leads.telefone — só aceita se determinístico
//      (normalizeBrazilianPhone válido), nunca um valor ambíguo/parcial.
// Retorna { ok:false } quando nenhum dos dois produz um número confiável —
// o chamador deve bloquear ANTES de chamar a Meta (invalid_recipient_phone).
// Verdadeiro quando o lead está em quarentena de identidade (criado quando o
// webhook achou mais de um candidato de telefone legado e não pôde decidir
// sozinho). Enquanto isso for true, NENHUM caminho de envio pode falar com a
// Meta para este lead — nem IA, nem manual, nem campanha/worker.
export function isPhoneIdentityReviewRequired(lead) {
  return lead?.dados_extraidos?.phone_identity_review_required === true;
}

export function resolveCanonicalSendPhone(lead) {
  if (lead?.telefone_normalizado) {
    const fromNormalized = normalizeBrazilianPhone(lead.telefone_normalizado);
    if (fromNormalized.valid && fromNormalized.canonical === String(lead.telefone_normalizado).replace(/\D/g, '')) {
      return { ok: true, phone: fromNormalized.canonical };
    }
  }
  const fromRaw = normalizeBrazilianPhone(lead?.telefone);
  if (fromRaw.valid) return { ok: true, phone: fromRaw.canonical };
  return { ok: false, phone: null };
}
