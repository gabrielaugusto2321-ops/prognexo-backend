import { z } from 'zod';

// Validação das variáveis de ambiente. Em produção, faltar uma variável
// obrigatória DERRUBA o boot (fail-fast). Combinações perigosas (dev apontando
// para produção, test com credencial real, staging usando callback de produção)
// também derrubam o boot. Nenhum valor é logado.

const optionalSecret = z.string().min(1).optional();
const bool = z.enum(['true', 'false']);

const schema = z.object({
  // Modo de runtime do Node (afeta libs). Mantém o vocabulário do ecossistema.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Ambiente lógico do Prognexo (4 ambientes). Default derivado de NODE_ENV.
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).optional(),

  // Hostnames considerados de PRODUÇÃO (CSV). Usado para detectar dev/staging/test
  // apontando por engano para recursos de produção. NÃO contém URL inventada —
  // o operador preenche com os hosts reais.
  PRODUCTION_HOSTS: z.string().optional(),

  // Topologia — usado pela checagem do store de rate-limit.
  APP_INSTANCE_COUNT: z.string().regex(/^\d+$/).optional(),

  // Supabase
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,

  // IA / integrações
  ANTHROPIC_API_KEY: optionalSecret,
  META_APP_SECRET: optionalSecret,
  META_SYSTEM_USER_TOKEN: optionalSecret,
  WHATSAPP_VERIFY_TOKEN: optionalSecret,
  VOYAGE_API_KEY: optionalSecret,
  CRON_SECRET: optionalSecret,

  // Frontend / CORS
  FRONTEND_URL: z.string().url().optional(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // CAPTCHA
  CAPTCHA_ENABLED: bool.default('false'),
  CAPTCHA_PROVIDER: z.string().default('turnstile'),
  CAPTCHA_SECRET: optionalSecret,

  // Webhooks — todos os gates começam FECHADOS para produção.
  WHATSAPP_WEBHOOK_SIGNATURE_ENFORCED: bool.default('true'),
  PAYMENT_WEBHOOKS_ENABLED: bool.default('false'),
  PAYMENT_WEBHOOKS_ENFORCE_SIGNATURE: bool.default('true'),
  TICTO_WEBHOOK_ENABLED: bool.default('false'),

  // Checkout legado com cartão — desligado por padrão em produção.
  LEGACY_CARD_CHECKOUT_ENABLED: bool.default('false'),

  // FASE 2.1 — núcleo multitenant. false = comportamento atual (doctor_id).
  // true (local) = leads/deals/events/campanhas resolvem via organization/membership,
  // mantendo compatibilidade com doctor_id pelo organization_doctor_map.
  TENANT_CORE_ENABLED: bool.default('false'),

  // FASE 2.6 — cutover do módulo de equipe para memberships. false = /team
  // continua 100% sobre user_doctor_access (comportamento atual, inalterado).
  // true (só local) = /team lê e escreve via memberships/membership_units
  // (RPCs transacionais da migration 0012); user_doctor_access permanece como
  // ponte só para role='closer'. Sem fallback silencioso: divergência que
  // possa afetar autorização retorna erro, nunca decide sozinha.
  TEAM_MEMBERSHIPS_ENABLED: bool.default('false'),

  // FASE 2.2 — criptografia de tokens/credenciais em repouso.
  //   ENABLED=false  -> comportamento atual (plaintext); a camada CredentialVault
  //                     apenas repassa para as colunas de texto puro.
  //   DUAL_WRITE=true -> grava ciphertext + plaintext (janela de migração).
  //   ALLOW_PLAINTEXT_READ=true -> leitura pode cair para plaintext quando ainda
  //                     não há ciphertext (janela de migração). NUNCA cai para
  //                     plaintext se o ciphertext existir e for inválido.
  TOKEN_ENCRYPTION_ENABLED: bool.default('false'),
  TOKEN_ENCRYPTION_DUAL_WRITE: bool.default('false'),
  TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ: bool.default('false'),
  // Keyring de chaves AES-256-GCM: JSON {"v1":"<32 bytes base64>", ...}.
  // ACTIVE_KEY nomeia a versão usada para gravar. Chaves nunca vão a log/DB/frontend.
  TOKEN_ENCRYPTION_KEYRING: optionalSecret,
  TOKEN_ENCRYPTION_ACTIVE_KEY: z.string().regex(/^v\d+$/).optional(),
  // Chave HMAC-SHA256 (>=32 bytes base64) para o blind index de webhook_token.
  // Independente das chaves AES. Trocar exige reconstruir os índices.
  TOKEN_LOOKUP_HMAC_KEY: optionalSecret,

  // Segredos de webhook de pagamento
  PAGARME_WEBHOOK_SECRET: optionalSecret,
  KIWIFY_WEBHOOK_SECRET: optionalSecret,
  HOTMART_HOTTOK: optionalSecret,
  TICTO_TOKEN: optionalSecret,

  // Google
  GOOGLE_CLIENT_ID: optionalSecret,
  GOOGLE_CLIENT_SECRET: optionalSecret,
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
});

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// Heurística: um JWT do Supabase tem 3 segmentos base64 e começa com "eyJ".
function looksLikeRealJwt(value) {
  return typeof value === 'string' && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

// Combinações perigosas → derrubam o boot. Nunca compara com URL inventada;
// usa a lista PRODUCTION_HOSTS que o operador informa.
function detectDangerousCombos(env) {
  const appEnv = env.APP_ENV || (env.NODE_ENV === 'test' ? 'test' : env.NODE_ENV);
  const prodHosts = (env.PRODUCTION_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const isProdHost = (url) => {
    const h = hostOf(url);
    return h ? prodHosts.includes(h.toLowerCase()) : false;
  };
  const problems = [];

  if (appEnv !== 'production') {
    // dev/test/staging não podem apontar para hosts de produção.
    for (const key of ['SUPABASE_URL', 'FRONTEND_URL', 'GOOGLE_REDIRECT_URI']) {
      if (env[key] && isProdHost(env[key])) {
        problems.push(`${key} aponta para um host de produção (PRODUCTION_HOSTS) com APP_ENV=${appEnv}`);
      }
    }
    // CORS não pode conter host de produção fora de produção.
    for (const origin of (env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (isProdHost(origin)) problems.push(`CORS_ALLOWED_ORIGINS contém host de produção com APP_ENV=${appEnv}`);
    }
  }

  if (appEnv === 'test' || env.NODE_ENV === 'test') {
    // test nunca deve ter credencial que pareça real.
    if (looksLikeRealJwt(env.SUPABASE_SERVICE_ROLE_KEY)) {
      problems.push('SUPABASE_SERVICE_ROLE_KEY parece um JWT real em ambiente de teste');
    }
    if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
      problems.push('ANTHROPIC_API_KEY parece uma chave real em ambiente de teste');
    }
  }

  if (appEnv === 'staging') {
    // staging usa credenciais próprias — não o callback oficial de produção.
    if (env.GOOGLE_REDIRECT_URI && isProdHost(env.GOOGLE_REDIRECT_URI)) {
      problems.push('GOOGLE_REDIRECT_URI usa um host de produção em staging');
    }
  }

  return problems;
}

// Decodifica base64 OU base64url para Buffer.
function decodeKeyMaterial(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return Buffer.from(normalized, 'base64');
  } catch {
    return null;
  }
}

// Parser estrito do keyring. Rejeita: JSON inválido, objeto vazio, rótulo de
// versão fora de /^v\d+$/, chave que não decodifica para exatamente 32 bytes,
// e rótulo de versão duplicado (JSON.parse silenciaria o duplicado).
export function parseKeyring(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('TOKEN_ENCRYPTION_KEYRING ausente');
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error('TOKEN_ENCRYPTION_KEYRING não é JSON válido');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('TOKEN_ENCRYPTION_KEYRING deve ser um objeto {versao: chave}');
  }
  // Detecção de rótulo duplicado no texto cru.
  const labelMatches = [...raw.matchAll(/"(v\d+)"\s*:/g)].map((m) => m[1]);
  const seen = new Set();
  for (const label of labelMatches) {
    if (seen.has(label)) throw new Error(`TOKEN_ENCRYPTION_KEYRING tem versão duplicada: ${label}`);
    seen.add(label);
  }
  const entries = Object.entries(obj);
  if (entries.length === 0) throw new Error('TOKEN_ENCRYPTION_KEYRING vazio');
  const keyring = new Map();
  for (const [label, material] of entries) {
    if (!/^v\d+$/.test(label)) throw new Error(`TOKEN_ENCRYPTION_KEYRING: rótulo inválido "${label}"`);
    const buf = decodeKeyMaterial(material);
    if (!buf || buf.length !== 32) {
      throw new Error(`TOKEN_ENCRYPTION_KEYRING: chave "${label}" não decodifica para 32 bytes`);
    }
    keyring.set(label, buf);
  }
  return keyring;
}

// Valida a configuração de criptografia de tokens. Só lança quando a criptografia
// é EXIGIDA (ENABLED=true) ou quando há combinação incoerente de flags.
function validateTokenEncryption(env, appEnv) {
  const enabled = env.TOKEN_ENCRYPTION_ENABLED === 'true';
  const dualWrite = env.TOKEN_ENCRYPTION_DUAL_WRITE === 'true';
  const allowPlaintextRead = env.TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ === 'true';
  const problems = [];
  const warnings = [];

  if (dualWrite && !enabled) problems.push('TOKEN_ENCRYPTION_DUAL_WRITE=true exige TOKEN_ENCRYPTION_ENABLED=true');

  if (enabled) {
    let keyring;
    try {
      keyring = parseKeyring(env.TOKEN_ENCRYPTION_KEYRING);
    } catch (err) {
      problems.push(err.message);
    }
    if (!env.TOKEN_ENCRYPTION_ACTIVE_KEY) {
      problems.push('TOKEN_ENCRYPTION_ACTIVE_KEY ausente com criptografia habilitada');
    } else if (keyring && !keyring.has(env.TOKEN_ENCRYPTION_ACTIVE_KEY)) {
      problems.push(`TOKEN_ENCRYPTION_ACTIVE_KEY "${env.TOKEN_ENCRYPTION_ACTIVE_KEY}" não está no keyring`);
    }
    const hmac = decodeKeyMaterial(env.TOKEN_LOOKUP_HMAC_KEY);
    if (!hmac || hmac.length < 32) {
      problems.push('TOKEN_LOOKUP_HMAC_KEY ausente ou com menos de 32 bytes');
    }
    // Combinação transitória mas insegura em produção.
    if (appEnv === 'production' && allowPlaintextRead) {
      warnings.push('TOKEN_ENCRYPTION_ALLOW_PLAINTEXT_READ=true em produção — só durante a migração');
    }
    if (appEnv === 'production' && dualWrite) {
      warnings.push('TOKEN_ENCRYPTION_DUAL_WRITE=true em produção — plaintext ainda é gravado');
    }
  }
  return { problems, warnings };
}

export function validateEnv(source = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  const env = parsed.data;
  const appEnv = env.APP_ENV || (env.NODE_ENV === 'test' ? 'test' : env.NODE_ENV);

  const dangerous = detectDangerousCombos(env);
  if (dangerous.length) {
    throw new Error(`Dangerous environment configuration:\n- ${dangerous.join('\n- ')}`);
  }

  const tokenEnc = validateTokenEncryption(env, appEnv);
  if (tokenEnc.problems.length) {
    throw new Error(`Invalid token-encryption configuration:\n- ${tokenEnc.problems.join('\n- ')}`);
  }
  for (const w of tokenEnc.warnings) {
    process.stderr.write(`[env] AVISO: ${w}\n`);
  }

  // Variáveis obrigatórias por ambiente lógico.
  if (appEnv === 'production' || appEnv === 'staging') {
    const required = [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'ANTHROPIC_API_KEY',
      'META_APP_SECRET',
      'META_SYSTEM_USER_TOKEN',
      'WHATSAPP_VERIFY_TOKEN',
      'VOYAGE_API_KEY',
      'CRON_SECRET',
      'FRONTEND_URL',
      'CORS_ALLOWED_ORIGINS',
    ];
    const missing = required.filter((key) => !env[key]);

    if (env.CAPTCHA_ENABLED !== 'true' || !env.CAPTCHA_SECRET) missing.push('CAPTCHA_ENABLED/CAPTCHA_SECRET');

    if (env.PAYMENT_WEBHOOKS_ENABLED === 'true' && env.PAYMENT_WEBHOOKS_ENFORCE_SIGNATURE === 'true') {
      for (const key of ['PAGARME_WEBHOOK_SECRET', 'KIWIFY_WEBHOOK_SECRET', 'HOTMART_HOTTOK']) {
        if (!env[key]) missing.push(key);
      }
    }

    if (missing.length) {
      throw new Error(`Missing required environment variables (APP_ENV=${appEnv}): ${missing.join(', ')}`);
    }
  }

  return { ...env, APP_ENV: appEnv };
}

export const env = validateEnv();
