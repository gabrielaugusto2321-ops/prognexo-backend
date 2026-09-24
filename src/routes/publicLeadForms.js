import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { supabase } from '../lib/supabase.js';
import { verifyCaptcha } from '../lib/captcha.js';
import { normalizeBrazilianPhone } from '../lib/phoneNormalization.js';
import { escolherCloserAutomatico } from '../lib/distribuicao.js';
import { buildLeadFormEmbedPage } from '../lib/leadFormEmbedPage.js';
import { createLeadFormToken, verifyLeadFormToken } from '../lib/leadFormToken.js';
import {
  leadFormEmbedLimiter, leadFormIpMinuteLimiter, leadFormIpHourlyLimiter, leadFormPublicIdLimiter,
} from '../middleware/rateLimits.js';

// Rotas PÚBLICAS (sem auth). O tenant vem SEMPRE da linha do formulário
// (resolvido por public_id); o cliente nunca escolhe doctor_id/organization_id.
const router = Router();

// Express 4 não captura rejeição de handler async: sem isso a requisição pendura.
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_criativo'];
const utmSchema = z.object(Object.fromEntries(UTM_KEYS.map((key) => [key, z.string().max(120).optional()]))).strict();

// .strict(): qualquer chave estranha (doctor_id, organization_id, form_id,
// lead_id, status...) é 400 e NADA é gravado.
const submitSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  email: z.string().trim().max(200).email().transform((value) => value.toLowerCase()),
  telefone: z.string().trim().min(8).max(30),
  consent: z.boolean().default(false),
  embed_token: z.string().max(1000),
  captcha_token: z.string().max(4000).optional(),
  website: z.string().max(200).optional(),
  utm: utmSchema.optional(),
  page_url: z.string().max(500).optional(),
}).strict();

const NOT_FOUND_HTML = '<!doctype html><meta charset="utf-8"><title>Não encontrado</title>';
const FORBIDDEN_HTML = '<!doctype html><meta charset="utf-8"><title>Acesso negado</title>';
const UNAVAILABLE_HTML = '<!doctype html><meta charset="utf-8"><title>Indisponível</title><p style="font:16px system-ui;padding:16px">Formulário temporariamente indisponível. Tente novamente mais tarde.</p>';

// A API já só grava https, mas o link do e-book é executado no navegador do
// visitante: uma linha adulterada direto no banco (javascript:, data:, http:)
// nunca pode chegar ao iframe.
function safeRedirect(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// CAPTCHA em produção é obrigatório (verifyCaptcha é fail-closed). Se a
// configuração está incompleta — típico: CAPTCHA_SITE_KEY ausente, então o
// widget nem renderiza — TODO envio seria recusado em silêncio. Melhor mostrar
// "indisponível" (e logar o motivo) do que um formulário que nunca funciona.
function captchaState() {
  const required = env.NODE_ENV === 'production' || env.CAPTCHA_ENABLED === 'true';
  const ready = env.CAPTCHA_ENABLED === 'true' && env.CAPTCHA_PROVIDER === 'turnstile'
    && Boolean(env.CAPTCHA_SECRET) && Boolean(env.CAPTCHA_SITE_KEY);
  return { required, ready };
}

function originOf(value) {
  try { return new URL(value).origin; } catch { return null; }
}

async function findActiveForm(publicId) {
  const { data, error } = await supabase.from('lead_capture_forms').select('*')
    .eq('public_id', publicId).eq('active', true).maybeSingle();
  if (error) throw error;
  return data;
}

async function currentConsentText(form) {
  const { data, error } = await supabase.from('lead_capture_form_consent_versions').select('consent_text')
    .eq('form_id', form.id).eq('version', form.consent_version).maybeSingle();
  if (error) throw error;
  return data?.consent_text || '';
}

// Origem do painel (FRONTEND_URL): pode EMOLDURAR o formulário pra prévia do
// admin, mas o envio a partir dela não grava nada (ver submit).
const previewOrigin = () => originOf(env.FRONTEND_URL);

router.get('/:publicId/embed', leadFormEmbedLimiter, wrap(async (req, res) => {
  const form = await findActiveForm(req.params.publicId);
  if (!form) return res.status(404).type('html').send(NOT_FOUND_HTML);

  // Referer (origem da página que embute) — o snippet usa referrerpolicy="origin".
  // Ausente/fora da lista = negado (fail-closed).
  const host = originOf(req.get('Referer'));
  const preview = previewOrigin();
  const allowedHost = Boolean(host) && form.allowed_origins.includes(host);
  const previewHost = Boolean(host) && host === preview;
  if (!allowedHost && !previewHost) return res.status(403).type('html').send(FORBIDDEN_HTML);

  const captcha = captchaState();
  if (captcha.required && !captcha.ready) {
    req.log?.error({ publicId: form.public_id }, 'Lead form unavailable: CAPTCHA incompleto (exige CAPTCHA_ENABLED=true, CAPTCHA_PROVIDER=turnstile, CAPTCHA_SECRET e CAPTCHA_SITE_KEY)');
    return res.status(503).type('html').send(UNAVAILABLE_HTML);
  }
  const nonce = crypto.randomBytes(18).toString('base64url');
  const captchaEnabled = captcha.ready;
  const ancestors = [...new Set([...form.allowed_origins, ...(preview ? [preview] : [])])].join(' ');
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'${captchaEnabled ? ' https://challenges.cloudflare.com' : ''}`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${ancestors}`,
    ...(captchaEnabled ? ['frame-src https://challenges.cloudflare.com'] : []),
  ].join('; ');

  // helmet manda X-Frame-Options: SAMEORIGIN; o controle de quem pode emoldurar
  // passa a ser o frame-ancestors acima (por formulário).
  res.removeHeader('X-Frame-Options');
  res.set({
    'Content-Security-Policy': csp,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });

  const utm = {};
  for (const key of UTM_KEYS) {
    if (typeof req.query[key] === 'string') utm[key] = req.query[key].slice(0, 120);
  }
  return res.type('html').send(buildLeadFormEmbedPage({
    form: { ...form, redirect_url: safeRedirect(form.redirect_url), consent_text: await currentConsentText(form) },
    token: createLeadFormToken({ pid: form.public_id, host }),
    nonce,
    utm,
    captchaEnabled,
    captchaSiteKey: env.CAPTCHA_SITE_KEY,
    preview: !allowedHost && previewHost,
  }));
}));

router.post('/:publicId/submit',
  leadFormIpMinuteLimiter, leadFormIpHourlyLimiter, leadFormPublicIdLimiter,
  wrap(async (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
    const body = parsed.data;

    const form = await findActiveForm(req.params.publicId);
    if (!form) return res.status(404).json({ error: 'form_not_found' });

    // Token assinado no embed: amarra o envio ao formulário E à página que o
    // embutiu. O domínio é revalidado (o formulário pode ter mudado de lista).
    const token = verifyLeadFormToken(body.embed_token, { pid: form.public_id });
    const previewSubmit = Boolean(token) && token.host === previewOrigin() && !form.allowed_origins.includes(token.host);
    if (!token || (!previewSubmit && !form.allowed_origins.includes(token.host))) {
      return res.status(403).json({ error: 'domain_not_allowed' });
    }
    if (Math.floor(Date.now() / 1000) - token.iat < 2) return res.status(400).json({ error: 'too_fast' });

    // Resposta UNIFORME: nunca revela se o lead já existia nem se o aceite foi
    // ignorado (opt_out prévio). O e-book/redirect sai com ou sem consentimento.
    const success = () => res.json({
      ok: true,
      message: form.success_message || 'Obrigado! Recebemos seus dados.',
      redirect_url: safeRedirect(form.redirect_url),
    });

    // Honeypot preenchido = robô: mesma resposta de sucesso, nada é gravado.
    if (body.website) return success();
    if (!(await verifyCaptcha(body.captcha_token, req.ip))) return res.status(403).json({ error: 'captcha_required' });

    const phone = normalizeBrazilianPhone(body.telefone);
    if (!phone.valid) return res.status(400).json({ error: 'invalid_phone' });

    // Prévia do painel: valida tudo e responde sucesso, mas NÃO cria lead no CRM.
    if (previewSubmit) return success();

    const { data, error } = await supabase.rpc('lead_form_submit', {
      p_public_id: form.public_id,
      p_nome: body.nome,
      p_email: body.email,
      p_telefone: body.telefone,
      p_telefone_normalizado: phone.canonical,
      p_consent: body.consent,
      p_page_origin: token.host,
      p_page_url: body.page_url || null,
      p_utm: body.utm || {},
      p_ip_hash: crypto.createHash('sha256').update(`${req.ip}:${form.public_id}`).digest('hex'),
    });
    if (error) {
      const message = String(error.message || '');
      if (message.includes('form_not_found')) return res.status(404).json({ error: 'form_not_found' });
      if (message.includes('invalid_phone')) return res.status(400).json({ error: 'invalid_phone' });
      req.log?.error({ err: error }, 'Lead form submit failed');
      return res.status(500).json({ error: 'internal_error', requestId: req.id });
    }

    // Distribuição automática só para lead NOVO (mesma regra do POST /leads).
    // Best-effort: falhar aqui nunca derruba a captura.
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.outcome === 'created' && row.lead_id) {
      try {
        const closerId = await escolherCloserAutomatico(form.doctor_id);
        if (closerId) {
          await Promise.all([
            supabase.from('leads').update({ sdr_responsavel_id: closerId }).eq('id', row.lead_id),
            supabase.from('deals').update({ sdr_responsavel_id: closerId }).eq('lead_id', row.lead_id),
          ]);
        }
      } catch (err) {
        req.log?.warn({ err }, 'Lead form owner assignment failed');
      }
    }
    return success();
  }));

export default router;
