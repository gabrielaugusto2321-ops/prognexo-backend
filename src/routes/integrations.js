import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { exchangeCodeForToken, registerPhoneNumber, subscribeAppToWaba } from '../lib/embeddedSignup.js';
import { CredentialVault } from '../lib/credentialVault.js';

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

const GATEWAYS = ['kiwify', 'hotmart', 'ticto', 'pagarme', 'whatsapp'];

async function resolveDoctorId(user, queryDoctorId) {
  if (user.role === 'doctor') {
    const { data } = await supabase.from('doctors').select('id').eq('owner_user_id', user.id).maybeSingle();
    return data?.id ?? null;
  }
  // Só admin pode consultar/editar integrações de outro médico via query param
  if (user.role === 'admin') return queryDoctorId ?? null;
  return null;
}

// GET /integrations?doctor_id= (obrigatório se for admin)
// Garante que os 5 tokens existam (cria os que faltarem) e devolve todos.
// access_token nunca volta no JSON — é write-only, só pra não vazar segredo pro frontend.
router.get('/', async (req, res) => {
  const doctorId = await resolveDoctorId(req.user, req.query.doctor_id);
  if (!doctorId) return res.status(400).json({ error: 'doctor_id necessário' });

  for (const gateway of GATEWAYS) {
    await supabase
      .from('integrations')
      .upsert({ doctor_id: doctorId, gateway }, { onConflict: 'doctor_id,gateway', ignoreDuplicates: true });
  }

  const { data, error } = await supabase.from('integrations').select('*').eq('doctor_id', doctorId);
  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }

  res.json(data.map(stripSecrets));
});

// PATCH /integrations/whatsapp — médico informa o phone_number_id e/ou o
// access_token permanente do próprio WhatsApp (gerado no Meta for Developers).
router.patch('/whatsapp', async (req, res) => {
  const doctorId = await resolveDoctorId(req.user, req.body.doctor_id);
  if (!doctorId) return res.status(400).json({ error: 'doctor_id necessário' });

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
  const doctorId = await resolveDoctorId(req.user, req.body.doctor_id);
  if (!doctorId) return res.status(400).json({ error: 'doctor_id necessário' });

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

export default router;
