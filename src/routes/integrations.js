import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { exchangeCodeForToken, registerPhoneNumber, subscribeAppToWaba } from '../lib/embeddedSignup.js';
import { CredentialVault } from '../lib/credentialVault.js';
import { attachTenantContext } from '../lib/tenantContext.js';
import { webhookTokenRotateLimiter } from '../middleware/rateLimits.js';
import { isWhatsappOperacional, gatewaysComWebhookRecebido } from '../lib/integrationStatus.js';
import { syncWhatsAppTemplates } from '../lib/whatsappTemplateSync.js';
import { isTemplateSelectable } from '../lib/whatsappTemplates.js';

// Papéis que podem rotacionar o segredo de webhook de pagamento.
const ROTATE_ROLES = new Set(['organization_owner', 'organization_admin']);
// janela de dedup: cliques/requisições duplicadas dentro disso não geram novo token.
const ROTATE_DEDUP_MS = 15_000;
const rotateSchema = z.object({ confirm: z.literal(true) }).strict();

// Remove qualquer coluna sensível/ciphertext antes de devolver ao frontend.
const SENSITIVE_COLS = new Set([
  'access_token', 'webhook_token',
  'access_token_encrypted', 'webhook_token_encrypted', 'webhook_token_lookup',
]);
function stripSecrets(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!SENSITIVE_COLS.has(k)) out[k] = v;
  out.access_token_configurado = Boolean(row.access_token || row.access_token_encrypted);
  out.webhook_token_configurado = Boolean(row.webhook_token || row.webhook_token_encrypted);
  return out;
}

const router = Router();
router.use(requireAuth);
router.use(attachTenantContext); // no-op se TENANT_CORE_ENABLED=false

const GATEWAYS = ['kiwify', 'hotmart', 'ticto', 'pagarme', 'whatsapp'];

async function resolveDoctorId(req, queryDoctorId) {
  // FASE 2.3: com tenant core ligado, o doctor_id vem SEMPRE do contexto
  // (organization_doctor_map) — nunca do query/body.
  if (req.tenant?.enabled) {
    return req.tenant.doctorId ?? null;
  }
  const user = req.user;
  if (user.role === 'doctor') {
    const { data } = await supabase.from('doctors').select('id').eq('owner_user_id', user.id).maybeSingle();
    return data?.id ?? null;
  }
  // Só admin pode consultar/editar integrações de outro médico via query param
  if (user.role === 'admin') return queryDoctorId ?? null;
  return null;
}
const orgOf = (req) => (req.tenant?.enabled && req.tenant.organizationId ? { organization_id: req.tenant.organizationId } : {});

// FASE 2.9 — com tenant core ligado e uma organização selecionada que ainda
// não tem `organization_doctor_map`, o doctor_id não resolve. Isso é lacuna de
// backfill, não "faltou um parâmetro": responde 409 (mesma semântica do
// disparo de campanha), nunca cai no caminho legado.
function respondDoctorIdGap(req, res) {
  if (req.tenant?.enabled && req.tenant.organizationId && !req.tenant.doctorId) {
    return res.status(409).json({ error: 'tenant_backfill_required' });
  }
  return res.status(400).json({ error: 'doctor_id necessário' });
}

// FASE 2 — closer nunca sincroniza o catálogo de templates (ação de
// configuração de integração, não de atendimento). Vale nos dois modos.
function isCloserRole(req) {
  if (req.tenant?.enabled) return req.tenant.role === 'closer';
  return req.user?.role === 'closer';
}

// GET /integrations?doctor_id= (obrigatório se for admin)
// Garante que os 5 tokens existam (cria os que faltarem) e devolve todos.
// access_token nunca volta no JSON — é write-only, só pra não vazar segredo pro frontend.
router.get('/', async (req, res) => {
  const doctorId = await resolveDoctorId(req, req.query.doctor_id);
  if (!doctorId) return respondDoctorIdGap(req, res);

  for (const gateway of GATEWAYS) {
    await supabase
      .from('integrations')
      .upsert({ doctor_id: doctorId, gateway, ...orgOf(req) }, { onConflict: 'doctor_id,gateway', ignoreDuplicates: true });
  }

  const { data, error } = await supabase.from('integrations').select('*').eq('doctor_id', doctorId);
  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }

  // Fonte única de verdade (src/lib/integrationStatus.js), a mesma que
  // GET /onboarding usa — WhatsApp e plataformas de venda nunca mais divergem
  // sobre o mesmo médico. Nenhum campo aqui expõe token: são só booleanos.
  const gatewaysComWebhook = await gatewaysComWebhookRecebido(doctorId);

  res.json(data.map((row) => {
    const out = stripSecrets(row);
    if (row.gateway === 'whatsapp') {
      out.whatsapp_operacional = isWhatsappOperacional(row);
    } else {
      out.webhook_recebido = gatewaysComWebhook.has(row.gateway);
    }
    return out;
  }));
});

// PATCH /integrations/whatsapp — médico informa o phone_number_id e/ou o
// access_token permanente do próprio WhatsApp (gerado no Meta for Developers).
router.patch('/whatsapp', async (req, res) => {
  const doctorId = await resolveDoctorId(req, req.body.doctor_id);
  if (!doctorId) return respondDoctorIdGap(req, res);

  const { external_id, access_token } = req.body;
  if (external_id === undefined && access_token === undefined) {
    return res.status(400).json({ error: 'Nada para atualizar' });
  }

  // Precisa do id da linha para amarrar o ciphertext (AAD) ao registro certo.
  const { data: alvo, error: findErr } = await supabase
    .from('integrations')
    .select('id')
    .eq('doctor_id', doctorId)
    .eq('gateway', 'whatsapp')
    .maybeSingle();
  if (findErr) { req.log?.error({ err: findErr }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  if (!alvo) return res.status(404).json({ error: 'integração não encontrada' });

  const patch = {};
  if (external_id !== undefined) patch.external_id = external_id;
  if (access_token !== undefined) {
    Object.assign(patch, CredentialVault.buildIntegrationCredentialPatch({
      id: alvo.id, doctorId, gateway: 'whatsapp', values: { access_token },
    }));
  }

  const { data, error } = await supabase
    .from('integrations')
    .update(patch)
    .eq('id', alvo.id)
    .select('doctor_id, gateway, external_id')
    .single();

  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  res.json({ ...data, access_token_configurado: access_token !== undefined });
});

// POST /integrations/whatsapp/embedded-callback
// Chamado pelo frontend assim que o médico termina o fluxo do Embedded
// Signup (o popup da Meta). Recebe o "code" do login, o waba_id e o
// phone_number_id que o próprio fluxo devolve via postMessage no navegador.
router.post('/whatsapp/embedded-callback', async (req, res) => {
  const doctorId = await resolveDoctorId(req, req.body.doctor_id);
  if (!doctorId) return respondDoctorIdGap(req, res);

  const { code, waba_id, phone_number_id } = req.body;
  if (!code || !waba_id || !phone_number_id) {
    return res.status(400).json({ error: 'code, waba_id e phone_number_id são obrigatórios' });
  }

  try {
    // Confirma que o login foi concluído de verdade (a Meta invalida o code
    // se for reaproveitado, então essa troca também evita replay).
    await exchangeCodeForToken(code);

    // Registra o número pra uso na Cloud API e inscreve nosso app nos
    // webhooks dessa WABA — sem isso o número fica "conectado" mas mudo.
    await registerPhoneNumber(phone_number_id);
    await subscribeAppToWaba(waba_id);
  } catch (err) {
    req.log?.error({ err }, 'WhatsApp embedded signup failed');
    return res.status(502).json({ error: 'embedded_signup_failed', requestId: req.id });
  }

  const { data, error } = await supabase
    .from('integrations')
    .update({ external_id: phone_number_id, waba_id })
    .eq('doctor_id', doctorId)
    .eq('gateway', 'whatsapp')
    .select('doctor_id, gateway, external_id, waba_id')
    .single();

  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  res.json({ ...data, conectado_via: 'embedded_signup' });
});

// POST /integrations/:id/webhook-token/rotate  { confirm: true }
// FASE 2.4 — gera um webhook_token NOVO para uma integração de pagamento.
// O token só é devolvido AQUI, uma vez. GET /integrations nunca o mostra.
// Não toca em WhatsApp / Meta (webhook_token é isolado — ver docs/platform/22).
router.post('/:id/webhook-token/rotate', webhookTokenRotateLimiter, async (req, res) => {
  // 1. confirmação explícita; body não carrega mais nada (schema .strict()).
  const parsed = rotateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'confirmation_required' });

  // 2. resolve a integração pelo id do path. NUNCA por id/org/doctor do body.
  const { data: integ, error: findErr } = await supabase
    .from('integrations')
    .select('id, doctor_id, organization_id, gateway, webhook_token_rotated_at, webhook_token_fingerprint')
    .eq('id', req.params.id)
    .maybeSingle();
  if (findErr) { req.log?.error({ err: findErr }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  // integração inexistente OU de outro tenant -> 404 (evita enumeração).
  if (!integ) return res.status(404).json({ error: 'not_found' });
  // WhatsApp NÃO usa webhook_token (resolve por phone_number_id + assinatura Meta).
  // Rotacionar não faria nada — bloqueia para não confundir e não tocar na Meta.
  if (integ.gateway === 'whatsapp') return res.status(400).json({ error: 'not_applicable_for_whatsapp' });

  // 3. autorização por papel + pertencimento ao tenant ativo.
  const t = req.tenant;
  if (t?.enabled) {
    const belongs =
      (integ.organization_id && integ.organization_id === t.organizationId) ||
      (t.doctorId && integ.doctor_id === t.doctorId);
    const isAllowedRole = ROTATE_ROLES.has(t.role) || (t.isPlatformAdmin && integ.organization_id);
    if (!belongs && !t.isPlatformAdmin) return res.status(404).json({ error: 'not_found' });
    if (!isAllowedRole) return res.status(403).json({ error: 'forbidden' });
    // membership suspensa já teria sido barrada no attachTenantContext (403).
  } else {
    // tenant core off: só doctor (dono) ou admin, como no resto de /integrations.
    const doctorId = await resolveDoctorId(req, integ.doctor_id);
    if (!doctorId || doctorId !== integ.doctor_id) return res.status(req.user.role === 'admin' ? 403 : 404).json({ error: req.user.role === 'admin' ? 'forbidden' : 'not_found' });
  }

  // 4. idempotência contra clique/requisição duplicada.
  const lastRotated = integ.webhook_token_rotated_at ? Date.parse(integ.webhook_token_rotated_at) : 0;
  if (lastRotated && Date.now() - lastRotated < ROTATE_DEDUP_MS) {
    return res.status(409).json({
      error: 'rotation_too_recent',
      has_webhook_token: true,
      webhook_token_fingerprint: integ.webhook_token_fingerprint,
      rotated_at: integ.webhook_token_rotated_at,
    });
  }

  // auditoria: nunca lança para fora do handler; nunca contém o token.
  const audit = (result, detail) =>
    supabase
      .from('webhook_token_events')
      .insert({
        integration_id: integ.id, organization_id: integ.organization_id, actor_user_id: req.user.id,
        gateway: integ.gateway, action: 'rotate', result, detail: detail || {},
      })
      .then((r) => { if (r?.error) req.log?.error({ err: r.error }, 'webhook token audit insert failed'); })
      .catch((err) => req.log?.error({ err }, 'webhook token audit insert failed'));

  // 5. gera o candidato EM MEMÓRIA. Ele só chega ao banco (e à resposta) se
  //    vencer o compare-and-swap abaixo.
  const { token, fingerprint, patch } = CredentialVault.buildWebhookTokenRotation({
    id: integ.id, doctorId: integ.doctor_id, gateway: integ.gateway,
  });

  // 6. UPDATE condicional (CAS): só aplica se o estado observado da integração
  //    (rotated_at + fingerprint + tenant + gateway) ainda for o mesmo. Sob
  //    READ COMMITTED, duas requisições concorrentes serializam no lock da
  //    linha: a segunda re-avalia o WHERE contra a linha já rotacionada e
  //    afeta 0 linhas. fingerprint muda a cada rotação (sha256 de token
  //    aleatório) -> impede ABA mesmo com rotated_at de mesma precisão.
  let cas = supabase.from('integrations').update(patch).eq('id', integ.id).eq('gateway', integ.gateway);
  cas = integ.organization_id
    ? cas.eq('organization_id', integ.organization_id)
    : cas.is('organization_id', null);
  cas = integ.webhook_token_rotated_at
    ? cas.eq('webhook_token_rotated_at', integ.webhook_token_rotated_at)
    : cas.is('webhook_token_rotated_at', null);
  cas = integ.webhook_token_fingerprint
    ? cas.eq('webhook_token_fingerprint', integ.webhook_token_fingerprint)
    : cas.is('webhook_token_fingerprint', null);

  const { data: updatedRows, error: upErr } = await cas.select('id');
  if (upErr) {
    req.log?.error({ err: upErr }, 'webhook token rotation failed');
    await audit('error');
    return res.status(500).json({ error: 'internal_error', requestId: req.id });
  }

  // 7. 0 linhas != erro -> outra rotação concorrente venceu. NUNCA devolve o
  //    token gerado; consulta só estado seguro; nunca sobrescreve.
  if (!updatedRows || updatedRows.length === 0) {
    await audit('conflict');
    const { data: fresh } = await supabase
      .from('integrations')
      .select('webhook_token_fingerprint, webhook_token_rotated_at')
      .eq('id', integ.id)
      .maybeSingle();
    return res.status(409).json({
      error: 'rotation_conflict',
      has_webhook_token: true,
      webhook_token_fingerprint: fresh?.webhook_token_fingerprint ?? null,
      rotated_at: fresh?.webhook_token_rotated_at ?? null,
    });
  }

  // 8. auditoria — NUNCA o token, só o fingerprint. Falha aqui não derruba a
  // resposta: a rotação já aconteceu e o usuário PRECISA receber o token.
  await audit('success', { fingerprint });

  // 7. retorno ÚNICO. Nunca mais dá para consultar `webhook_token`.
  res.status(200).json({
    webhook_token: token,
    webhook_token_fingerprint: fingerprint,
    webhook_url: `/webhooks/${integ.gateway}`,
    header: 'X-Prognexo-Webhook-Token',
    rotated_at: patch.webhook_token_rotated_at,
    warning: 'Guarde este token agora. Ele não poderá ser consultado novamente. O token anterior deixou de funcionar.',
  });
});

// POST /integrations/whatsapp/templates/sync
// FASE 2 — pagina TODOS os templates da WABA do médico (ver
// src/lib/whatsappTemplateSync.js) e substitui o cache local numa única
// transação (RPC). Nunca cria/edita/aprova template — só espelha o que já
// existe no Business Manager da Meta. Closer nunca sincroniza.
router.post('/whatsapp/templates/sync', async (req, res) => {
  // Checa o papel closer ANTES de resolver doctor_id: em modo legado
  // resolveDoctorId() não sabe resolver médico pra closer (retorna null), o
  // que faria o bloqueio cair mascarado como 400 "doctor_id necessário" em
  // vez do 403 explícito que essa ação exige.
  if (isCloserRole(req)) return res.status(403).json({ error: 'forbidden' });
  const doctorId = await resolveDoctorId(req, req.body.doctor_id);
  if (!doctorId) return respondDoctorIdGap(req, res);

  const { data: integ, error: findErr } = await supabase
    .from('integrations')
    .select('waba_id, organization_id')
    .eq('doctor_id', doctorId)
    .eq('gateway', 'whatsapp')
    .maybeSingle();
  if (findErr) { req.log?.error({ err: findErr }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  if (!integ?.waba_id) return res.status(409).json({ error: 'whatsapp_waba_not_configured' });

  let credentials;
  try {
    credentials = await CredentialVault.resolveWhatsAppSendCredentials({ doctorId });
  } catch (err) {
    req.log?.error({ err }, 'WhatsApp integration credential unreadable');
    return res.status(400).json({ error: 'WhatsApp não configurado para este médico' });
  }
  if (!credentials.accessToken) {
    return res.status(400).json({ error: 'Nenhum token de envio disponível para este médico' });
  }

  try {
    const result = await syncWhatsAppTemplates({
      doctorId,
      organizationId: integ.organization_id ?? (req.tenant?.enabled ? req.tenant.organizationId : null),
      wabaId: integ.waba_id,
      accessToken: credentials.accessToken,
    });
    res.json({
      synced: result.synced,
      upserted: result.upserted,
      deactivated: result.deactivated,
      synced_at: new Date().toISOString(),
    });
  } catch (err) {
    // Nunca loga err.message (pode ecoar texto da resposta da Meta) — só um
    // código sanitizado, nunca o token nem a resposta bruta.
    req.log?.error({ err: { code: err?.code || 'template_sync_failed' } }, 'WhatsApp template sync failed');
    return res.status(502).json({ error: 'whatsapp_template_sync_failed', requestId: req.id });
  }
});

// GET /integrations/whatsapp/templates?doctor_id=
// Nunca devolve meta_template_id bruto de componentes, waba_id ou token —
// só os campos necessários para o seletor de campanha e para a tela de
// Integrações mostrar quantidade de aprovados + última sincronização.
router.get('/whatsapp/templates', async (req, res) => {
  const doctorId = await resolveDoctorId(req, req.query.doctor_id);
  if (!doctorId) return respondDoctorIdGap(req, res);

  const { data, error } = await supabase
    .from('whatsapp_templates')
    .select('id, meta_template_id, nome, idioma, categoria, status, body_text, body_variable_count, supported, unsupported_reason, active, last_synced_at')
    .eq('doctor_id', doctorId)
    .order('nome', { ascending: true });
  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }

  const rows = data || [];
  const lastSyncedAt = rows.reduce((max, t) => (t.last_synced_at && (!max || t.last_synced_at > max) ? t.last_synced_at : max), null);
  res.json({
    templates: rows,
    approved_count: rows.filter(isTemplateSelectable).length,
    last_synced_at: lastSyncedAt,
  });
});

export default router;
