import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { attachTenantContext } from '../lib/tenantContext.js';
import { teamMutationLimiter, activationLimiter } from '../middleware/rateLimits.js';
import { TokenCipher, buildAad } from '../lib/credentialVault.js';

const router = Router();
const roles = ['organization_owner','organization_admin','manager','closer','receptionist','professional','financial','viewer'];
const createSchema = z.object({ email: z.string().trim().email(), role: z.enum(roles), idempotency_key: z.string().trim().min(8).max(200).optional() }).strict();
const emptySchema = z.object({}).strict();
const enabled = () => env.TEAM_MEMBERSHIPS_ENABLED === 'true' && env.TEAM_INVITE_OUTBOX_ENABLED === 'true';
const manager = (req) => req.tenant?.isPlatformAdmin || ['organization_owner','organization_admin'].includes(req.tenant?.role);
const expose = (i) => ({ id:i.id, email:i.email, intended_role:i.intended_role, status:i.status, expires_at:i.expires_at, created_at:i.created_at, accepted_at:i.accepted_at, cancelled_at:i.cancelled_at, last_error_code:i.last_error_code });
const statuses = { not_found:404, forbidden:403, conflict:409, invalid_role:400, invalid_email:400, invalid_state:409, invalid_idempotency_key:400, cancelled:409, expired:410, invalid_token_marker:400 };
function rpcFailure(res, req, error, crossTenant = false) {
  const code=error?.message?.split('\n')[0]?.trim();
  if (crossTenant && code==='forbidden') return res.status(404).json({error:'not_found'});
  if (statuses[code]) return res.status(statuses[code]).json({error:code});
  req.log?.error({ err: error }, 'team invitation operation failed');
  return res.status(500).json({error:'internal_error',requestId:req.id});
}

// NUNCA usamos `properties.action_link` bruto (ele aponta pro endpoint
// /auth/v1/verify do PRÓPRIO GoTrue, que faz a verificação server-side e só
// DEPOIS redireciona — formato incompatível com o HashRouter do frontend,
// que não vê nada fora do `#`). Em vez disso, seguimos o padrão que a própria
// doc do SDK descreve para "custom email provider": usamos `hashed_token` +
// `verification_type` para montar NÓS MESMOS o link, já dentro do `#` do
// HashRouter — a página /aceitar-convite chama supabase.auth.verifyOtp
// client-side com esse token_hash. invitation_id vai em claro na URL (não é
// segredo, só roteia qual convite mostrar); token_hash É sensível (de posse
// dele dá pra criar sessão) — por isso citação nunca em log, só dentro do
// payload cifrado da outbox.
// IMPORTANTE: o parâmetro NÃO se chama `type` — o frontend legado (App.jsx)
// detecta convite/recuperação de senha com `window.location.hash.includes(
// 'type=invite')` (substring cru, antes de qualquer roteamento). Se este link
// usasse `type=invite` na querystring, essa checagem colidiria e a pessoa
// cairia na tela ERRADA (definir senha do fluxo antigo) em vez da nova tela
// de aceite de convite. `verification_type` é o nome que evita a colisão; o
// VALOR continua sendo exatamente o que `supabase.auth.verifyOtp({ type })`
// espera (`invite` ou `magiclink`).
function buildAcceptLink(invitationId, { hashedToken, verificationType }) {
  const base = (env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  const qs = new URLSearchParams({ invitation_id: invitationId, token_hash: hashedToken, verification_type: verificationType });
  return `${base}/#/aceitar-convite?${qs.toString()}`;
}

async function generateAndQueue(invitation) {
  let link = await supabase.auth.admin.generateLink({ type:'invite', email:invitation.email });
  if (link.error && /already registered/i.test(link.error.message || '')) link = await supabase.auth.admin.generateLink({ type:'magiclink', email:invitation.email });
  if (link.error || !link.data?.properties?.hashed_token || !link.data?.user?.id) throw Object.assign(new Error('auth_link_failed'), { code:'auth_link_failed' });
  const eventId=crypto.randomUUID();
  const acceptLink = buildAcceptLink(invitation.id, { hashedToken: link.data.properties.hashed_token, verificationType: link.data.properties.verification_type || 'invite' });
  const payload=JSON.stringify({ to:invitation.email, actionLink:acceptLink, organizationName:invitation.organization_name || 'Prognexo' });
  const aad=buildAad({table:'outbox_events',recordId:eventId,field:'payload',scope:`org:${invitation.organization_id}`,provider:'team_invite'});
  const encrypted=TokenCipher.encrypt(payload,aad);
  return supabase.rpc('team_invitation_attach_and_enqueue', { p_invitation_id:invitation.id,p_auth_user_id:link.data.user.id,p_event_id:eventId,p_event_type:'send_invitation_email',p_payload_encrypted:encrypted,p_idempotency_key:`${invitation.id}:send:${eventId}` });
}

const protectedRouter=Router();
protectedRouter.use(requireAuth,attachTenantContext);
protectedRouter.use((req,res,next)=>{ if(!enabled() || !req.tenant?.enabled) return res.status(404).json({error:'not_found'}); if(!manager(req)) return res.status(403).json({error:'forbidden'}); next(); });

protectedRouter.post('/',teamMutationLimiter,async(req,res)=>{
 const parsed=createSchema.safeParse(req.body); if(!parsed.success)return res.status(400).json({error:'invalid_body'});
 const org=req.tenant.organizationId; const email=parsed.data.email.toLowerCase();
 const key=parsed.data.idempotency_key || crypto.createHash('sha256').update(`${org}\u001f${email}\u001f${parsed.data.role}`).digest('hex');
 const created=await supabase.rpc('team_invitation_create',{p_organization_id:org,p_actor_user_id:req.user.id,p_email:email,p_role:parsed.data.role,p_idempotency_key:key});
 if(created.error)return rpcFailure(res,req,created.error);
 if(created.data.status==='pending' || created.data.status==='failed'){
   const marked=await supabase.rpc('team_invitation_mark_provisioning',{p_invitation_id:created.data.id}); if(marked.error)return rpcFailure(res,req,marked.error);
   try { const queued=await generateAndQueue(marked.data); if(queued.error)throw Object.assign(new Error('database_enqueue_failed'),{code:'database_enqueue_failed',cause:queued.error}); created.data.status='queued'; }
   catch(error){ await supabase.rpc('team_invitation_mark_failed',{p_invitation_id:created.data.id,p_error_code:'auth_link_failed'}); req.log?.error({code:error.code||'auth_link_failed',invitationId:created.data.id},'team invitation provisioning failed'); return res.status(502).json({error:'invitation_provisioning_failed'}); }
 }
 return res.status(201).json(expose(created.data));
});

protectedRouter.get('/',async(req,res)=>{
 const {data,error}=await supabase.from('organization_invitations').select('id,email,intended_role,status,expires_at,created_at,accepted_at,cancelled_at,last_error_code').eq('organization_id',req.tenant.organizationId).order('created_at',{ascending:false});
 if(error)return rpcFailure(res,req,error); return res.json({invitations:(data||[]).map(expose)});
});

protectedRouter.post('/:id/cancel',teamMutationLimiter,async(req,res)=>{
 if(!emptySchema.safeParse(req.body||{}).success)return res.status(400).json({error:'invalid_body'});
 const out=await supabase.rpc('team_invitation_cancel',{p_organization_id:req.tenant.organizationId,p_actor_user_id:req.user.id,p_invitation_id:req.params.id});
 if(out.error)return rpcFailure(res,req,out.error,true); return res.json({id:out.data.id,status:out.data.status});
});

protectedRouter.post('/:id/resend',teamMutationLimiter,async(req,res)=>{
 if(!emptySchema.safeParse(req.body||{}).success)return res.status(400).json({error:'invalid_body'});
 const found=await supabase.rpc('team_invitation_prepare_resend',{p_organization_id:req.tenant.organizationId,p_actor_user_id:req.user.id,p_invitation_id:req.params.id});
 if(found.error)return rpcFailure(res,req,found.error,true);
 try { const out=await generateAndQueue(found.data); if(out.error)return rpcFailure(res,req,out.error); return res.json({id:found.data.id,status:'queued'}); }
 catch { return res.status(502).json({error:'invitation_provisioning_failed'}); }
});

router.post('/:id/accept',activationLimiter,async(req,res)=>{
 if(!enabled())return res.status(404).json({error:'not_found'});
 const header=req.headers.authorization; if(!header?.startsWith('Bearer '))return res.status(401).json({error:'unauthorized'});
 const {data:{user}={},error}=await supabase.auth.getUser(header.slice(7)); if(error||!user)return res.status(401).json({error:'unauthorized'});
 const marker=crypto.createHash('sha256').update(header.slice(7)).digest('hex').slice(0,16);
 const out=await supabase.rpc('team_invitation_accept',{p_auth_user_id:user.id,p_invitation_id:req.params.id,p_token_marker:marker});
 if(out.error)return rpcFailure(res,req,out.error); return res.json({ok:true,status:'accepted'});
});
router.use(protectedRouter);
export default router;
