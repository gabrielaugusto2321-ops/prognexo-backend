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

export function normalizeBrazilianPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  let nacional = null;
  if (digits.length === 10 || digits.length === 11) {
    nacional = digits;
  } else if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    nacional = digits.slice(2);
  } else {
    return { valid: false, normalized: null, reason: 'comprimento_invalido' };
  }
  const ddd = Number(nacional.slice(0, 2));
  if (!DDDS_VALIDOS.has(ddd)) {
    return { valid: false, normalized: null, reason: 'ddd_invalido' };
  }
  return { valid: true, normalized: `55${nacional}`, reason: null };
}
