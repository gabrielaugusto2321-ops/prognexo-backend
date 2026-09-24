import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';
import { attachTenantContext } from '../lib/tenantContext.js';

// Gestão dos formulários de captação (autenticada). doctor_id/organization_id
// NUNCA vêm do corpo: são derivados do contexto do usuário.
const router = Router();

// Express 4 não captura rejeição de handler async: sem isso a requisição pendura.
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const MANAGER_TENANT_ROLES = new Set(['organization_owner', 'organization_admin', 'manager']);
const stageSchema = z.enum(['lead', 'conversa_iniciada', 'reuniao_marcada', 'proposta']);
const originsSchema = z.array(z.string().max(300)).min(1).max(10);
const httpsUrl = z.string().max(2000).url().refine((value) => value.startsWith('https://'), 'https_required');
const consentSchema = z.string().trim().min(10).max(1000);

// .strict(): doctor_id, organization_id, public_id... viram 400.
const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  allowed_origins: originsSchema,
  pipeline_stage: stageSchema.default('lead'),
  redirect_url: httpsUrl.optional(),
  success_message: z.string().trim().max(300).optional(),
  consent_text: consentSchema,
}).strict();

const patchSchema = z.object({
  name: z.string().trim().min(2).max(120),
  allowed_origins: originsSchema,
  pipeline_stage: stageSchema,
  redirect_url: httpsUrl.nullable(),
  success_message: z.string().trim().max(300).nullable(),
  consent_text: consentSchema,
  active: z.boolean(),
}).partial().strict().refine((value) => Object.keys(value).length > 0, 'empty_patch');

// Normaliza para origem pura (esquema+host+porta). https sempre; http só para
// localhost fora de produção. Sem caminho, consulta, credenciais ou curinga.
function normalizeOrigins(values) {
  const origins = [];
  for (const value of values) {
    if (value.includes('*')) throw new Error('invalid_origin');
    let url;
    try { url = new URL(value); } catch { throw new Error('invalid_origin'); }
    const localhostHttp = url.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(url.hostname) && env.APP_ENV !== 'production';
    if (url.protocol !== 'https:' && !localhostHttp) throw new Error('invalid_origin');
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('invalid_origin');
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

router.use(requireAuth);
router.use(attachTenantContext);
router.use((req, res, next) => {
  const allowed = req.tenant?.enabled
    ? (req.tenant.isPlatformAdmin || MANAGER_TENANT_ROLES.has(req.tenant.role))
    : ['doctor', 'admin'].includes(req.user?.role);
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  return next();
});

// Escopo do chamador. Tenant ligado: o médico/organização do contexto.
// Legado: o médico do próprio usuário; admin legado só LISTA/edita (não há como
// escolher um médico aqui, então criar exige um médico resolvível).
async function resolveScope(req) {
  if (req.tenant?.enabled) return { doctorId: req.tenant.doctorId, organizationId: req.tenant.organizationId };
  if (req.user.role === 'admin') return { doctorId: null, organizationId: null, allDoctors: true };
  const ids = await getScopedDoctorIds(req.user);
  return { doctorId: ids?.length === 1 ? ids[0] : null, organizationId: null };
}

async function currentConsentText(form) {
  const { data, error } = await supabase.from('lead_capture_form_consent_versions').select('consent_text')
    .eq('form_id', form.id).eq('version', form.consent_version).maybeSingle();
  if (error) throw error;
  return data?.consent_text || '';
}

async function present(form) {
  return {
    id: form.id,
    public_id: form.public_id,
    name: form.name,
    active: form.active,
    allowed_origins: form.allowed_origins,
    pipeline_stage: form.pipeline_stage,
    redirect_url: form.redirect_url ?? null,
    success_message: form.success_message ?? null,
    consent_text: await currentConsentText(form),
    consent_version: form.consent_version,
    created_at: form.criado_em,
  };
}

const internalError = (req, res) => res.status(500).json({ error: 'internal_error', requestId: req.id });

router.get('/', wrap(async (req, res) => {
  const scope = await resolveScope(req);
  if (!scope.allDoctors && !scope.doctorId) return res.status(403).json({ error: 'forbidden' });
  let query = supabase.from('lead_capture_forms').select('*').order('criado_em', { ascending: false });
  if (!scope.allDoctors) query = query.eq('doctor_id', scope.doctorId);
  const { data, error } = await query;
  if (error) return internalError(req, res);
  return res.json(await Promise.all((data || []).map(present)));
}));

router.post('/', wrap(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  let allowedOrigins;
  try { allowedOrigins = normalizeOrigins(parsed.data.allowed_origins); } catch { return res.status(400).json({ error: 'invalid_payload' }); }

  const scope = await resolveScope(req);
  if (!scope.doctorId) return res.status(403).json({ error: 'forbidden' });

  const { consent_text: consentText, ...fields } = parsed.data;
  const inserted = await supabase.from('lead_capture_forms').insert({
    ...fields,
    allowed_origins: allowedOrigins,
    public_id: `lf_${crypto.randomBytes(12).toString('base64url')}`,
    doctor_id: scope.doctorId,
    organization_id: scope.organizationId ?? null,
    created_by: req.user.id,
    active: true,
    consent_version: 1,
  }).select('*').single();
  if (inserted.error) return internalError(req, res);

  const version = await supabase.from('lead_capture_form_consent_versions').insert({
    form_id: inserted.data.id, version: 1, consent_text: consentText, created_by: req.user.id,
  });
  if (version.error) {
    // Sem a versão 1 o formulário não teria prova possível: desfaz.
    await supabase.from('lead_capture_forms').delete().eq('id', inserted.data.id);
    return internalError(req, res);
  }
  return res.status(201).json(await present(inserted.data));
}));

router.patch('/:id', wrap(async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  const changes = { ...parsed.data };
  if (changes.allowed_origins) {
    try { changes.allowed_origins = normalizeOrigins(changes.allowed_origins); } catch { return res.status(400).json({ error: 'invalid_payload' }); }
  }

  const scope = await resolveScope(req);
  let lookup = supabase.from('lead_capture_forms').select('*').eq('id', req.params.id);
  if (!scope.allDoctors) {
    if (!scope.doctorId) return res.status(404).json({ error: 'not_found' });
    lookup = lookup.eq('doctor_id', scope.doctorId);
  }
  const found = await lookup.maybeSingle();
  if (found.error) return internalError(req, res);
  if (!found.data) return res.status(404).json({ error: 'not_found' }); // outro tenant = 404, nunca 403

  // Texto novo = versão nova (histórico imutável). Texto idêntico ao atual
  // NÃO gera versão: reenviar o formulário salvo não pode inflar o histórico.
  if (changes.consent_text !== undefined) {
    const newText = changes.consent_text;
    delete changes.consent_text;
    if (newText !== (await currentConsentText(found.data))) {
      const version = found.data.consent_version + 1;
      const inserted = await supabase.from('lead_capture_form_consent_versions').insert({
        form_id: found.data.id, version, consent_text: newText, created_by: req.user.id,
      });
      // unique(form_id, version): duas edições simultâneas — a perdedora refaz.
      if (inserted.error?.code === '23505') return res.status(409).json({ error: 'conflict' });
      if (inserted.error) return internalError(req, res);
      changes.consent_version = version;
    }
  }

  const updated = await supabase.from('lead_capture_forms')
    .update({ ...changes, atualizado_em: new Date().toISOString() })
    .eq('id', found.data.id).select('*').single();
  if (updated.error) return internalError(req, res);
  return res.json(await present(updated.data));
}));

export default router;
