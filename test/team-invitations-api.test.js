import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeDb } from './helpers/mockSupabase.js';

process.env.NODE_ENV='test'; process.env.CORS_ALLOWED_ORIGINS='https://app.test';
const key=Buffer.alloc(32,3).toString('base64');
const ORG_A='30000000-0000-4000-8000-000000000001';
const ORG_B='30000000-0000-4000-8000-000000000002';
const OWNER='40000000-0000-4000-8000-000000000001';
const INVITED='40000000-0000-4000-8000-000000000002';
// FASE 2.9 — invariante de compat: toda org ativa tem organization_doctor_map.
const DOC_A_MAP='d0000000-0000-4000-8000-0000000000a1';
const DOC_B_MAP='d0000000-0000-4000-8000-0000000000b1';
let db;
vi.mock('../src/lib/supabase.js',()=>({get supabase(){return db.client;}}));

function seed(){
 db=makeDb({users:[{id:OWNER,email:'owner@x.test',role:'doctor',ativo:true}],organizations:[{id:ORG_A,name:'A',status:'active'},{id:ORG_B,name:'B',status:'active'}],memberships:[{id:'m-owner',organization_id:ORG_A,user_id:OWNER,role:'organization_owner',status:'active'}],organization_doctor_map:[{organization_id:ORG_A,doctor_id:DOC_A_MAP,default_unit_id:null},{organization_id:ORG_B,doctor_id:DOC_B_MAP,default_unit_id:null}],organization_invitations:[],outbox_events:[],membership_units:[],units:[],platform_admins:[]});
 db.setAuthUser('owner-token',{id:OWNER}); db.setAuthUser('invite-token',{id:INVITED,email_confirmed_at:new Date().toISOString()});
 const original=db.client.rpc;
 db.client.rpc=vi.fn(async(name,p)=>{
  if(name==='team_invitation_create'){
   const existing=db.tables.organization_invitations.find(i=>i.organization_id===p.p_organization_id&&i.email===p.p_email&&['pending','queued','sent'].includes(i.status));
   if(existing)return {data:existing,error:null};
   const row={id:'50000000-0000-4000-8000-000000000001',organization_id:p.p_organization_id,email:p.p_email,intended_role:p.p_role,invited_by_user_id:p.p_actor_user_id,status:'pending',expires_at:new Date(Date.now()+86400000).toISOString(),created_at:new Date().toISOString()}; db.tables.organization_invitations.push(row); return {data:row,error:null};
  }
  if(name==='team_invitation_mark_provisioning'){const i=db.tables.organization_invitations.find(x=>x.id===p.p_invitation_id);i.status='provisioning';return {data:i,error:null};}
  if(name==='team_invitation_attach_and_enqueue'){
   const i=db.tables.organization_invitations.find(x=>x.id===p.p_invitation_id);
   i.status='queued'; i.auth_user_id=p.p_auth_user_id;
   // idempotente quanto à membership, igual à RPC real (on conflict do nothing
   // + fallback de select) — reenvio não deveria criar uma segunda linha.
   if(!db.tables.memberships.some(m=>m.organization_id===i.organization_id&&m.user_id===p.p_auth_user_id)){
    db.tables.memberships.push({id:'m-invited',organization_id:i.organization_id,user_id:p.p_auth_user_id,role:i.intended_role,status:'invited'});
   }
   i.membership_id='m-invited';
   db.tables.outbox_events.push({id:p.p_event_id,organization_id:i.organization_id,aggregate_id:i.id,payload:p.p_payload_encrypted,status:'pending'});
   return {data:{status:'queued'},error:null};
  }
  if(name==='team_invitation_cancel'){const i=db.tables.organization_invitations.find(x=>x.id===p.p_invitation_id&&x.organization_id===p.p_organization_id);if(!i)return {data:null,error:{message:'not_found'}};i.status='cancelled';return {data:i,error:null};}
  if(name==='team_invitation_prepare_resend'){
   const i=db.tables.organization_invitations.find(x=>x.id===p.p_invitation_id&&x.organization_id===p.p_organization_id);
   if(!i)return {data:null,error:{message:'not_found'}};
   if(!['queued','sent','failed'].includes(i.status))return {data:null,error:{message:'invalid_state'}};
   // mesmo comportamento da RPC real: cancela qualquer outbox_event ainda pendente pra este convite antes de liberar reenvio.
   db.tables.outbox_events.filter(e=>e.aggregate_id===i.id&&['pending','retry'].includes(e.status)).forEach(e=>{e.status='cancelled';});
   i.status='ready';
   return {data:i,error:null};
  }
  if(name==='team_invitation_accept'){const i=db.tables.organization_invitations.find(x=>x.id===p.p_invitation_id);if(!i)return {data:null,error:{message:'not_found'}};if(i.auth_user_id!==p.p_auth_user_id)return {data:null,error:{message:'forbidden'}};i.status='accepted';return {data:i,error:null};}
  return original(name,p);
 });
 // hashed_token único a cada chamada — espelha o GoTrue de verdade (testado
 // empiricamente contra Supabase local: uma 2ª chamada de generateLink pro
 // MESMO e-mail gera um token novo e invalida o anterior). Sem isso, um
 // teste que compara "o link mudou depois do reenvio" seria falso-positivo.
 let generateLinkCalls=0;
 db.client.auth.admin.generateLink=vi.fn(async({email,options})=>{ generateLinkCalls+=1; return {data:{user:{id:INVITED},properties:{action_link:`https://local.test/verify?email=${encodeURIComponent(email)}&redirect_to=${encodeURIComponent(options?.redirectTo||'')}`,hashed_token:`token-${generateLinkCalls}`}},error:null}; });
}

async function app(on=true, { membershipsOn = on, outboxOn = on } = {}){
 vi.resetModules(); process.env.TENANT_CORE_ENABLED='true'; process.env.TEAM_MEMBERSHIPS_ENABLED=membershipsOn?'true':'false'; process.env.TEAM_INVITE_OUTBOX_ENABLED=outboxOn?'true':'false'; process.env.TEAM_INVITE_EMAIL_DELIVERY_ENABLED='false'; process.env.TOKEN_ENCRYPTION_ENABLED='false'; process.env.TOKEN_ENCRYPTION_KEYRING=JSON.stringify({v1:key}); process.env.TOKEN_ENCRYPTION_ACTIVE_KEY='v1';
 return (await import('../src/server.js')).createApp();
}
const auth=t=>({Authorization:`Bearer ${t}`,'X-Organization-Id':ORG_A});

describe('HTTP /team/invitations',()=>{
 beforeEach(seed);
 it('flag desligada: superfície não existe',async()=>expect((await request(await app(false)).get('/team/invitations').set(auth('owner-token'))).status).toBe(404));
 it('POST usa tenant do contexto, normaliza email e nunca responde link/token/payload',async()=>{
  const res=await request(await app()).post('/team/invitations').set(auth('owner-token')).send({email:'  PERSON@X.TEST ',role:'viewer'});
  expect(res.status).toBe(201); expect(res.body.email).toBe('person@x.test'); expect(JSON.stringify(res.body)).not.toMatch(/action|token|payload/i);
  expect(db.tables.organization_invitations[0].organization_id).toBe(ORG_A); expect(db.tables.outbox_events[0].payload).toMatch(/^e1\.v1\./); expect(db.tables.outbox_events[0].payload).not.toContain('local.test');
 });
 it('link de aceite é montado com hashed_token dentro do #/ (HashRouter) e carrega o invitation_id — nunca o action_link bruto do GoTrue', async () => {
  const builtApp = await app();
  const res = await request(builtApp).post('/team/invitations').set(auth('owner-token')).send({ email: 'redir@x.test', role: 'viewer' });
  const stored = db.tables.outbox_events.find((e) => e.aggregate_id === res.body.id);
  // credentialVault.js precisa ser reimportado DEPOIS do vi.resetModules() de
  // app() — o import estático no topo do arquivo ficou preso à instância de
  // ANTES do reset, com state() vazio (sem o keyring que app() configurou).
  const vault = await import('../src/lib/credentialVault.js');
  const decrypted = JSON.parse(vault.TokenCipher.decrypt(stored.payload, vault.buildAad({ table: 'outbox_events', recordId: stored.id, field: 'payload', scope: `org:${ORG_A}`, provider: 'team_invite' })));
  expect(decrypted.actionLink).toContain('/#/aceitar-convite?');
  expect(decrypted.actionLink).toContain(`invitation_id=${res.body.id}`);
  expect(decrypted.actionLink).toMatch(/token_hash=token-\d+/);
  expect(decrypted.actionLink).toContain('verification_type=invite');
  expect(decrypted.actionLink).not.toContain('/verify?token='); // nunca o action_link bruto do GoTrue (fora do hash, quebraria o HashRouter)
  expect(decrypted.actionLink).not.toMatch(/[?&]type=invite/); // colidiria com VEIO_DE_CONVITE do App.jsx (window.location.hash.includes('type=invite'))
 });
 it('resend invalida o link anterior (novo hashed_token) e cancela o outbox_event pendente antigo — nunca dois links válidos ao mesmo tempo', async () => {
  const builtApp = await app();
  const created = await request(builtApp).post('/team/invitations').set(auth('owner-token')).send({ email: 'resend@x.test', role: 'viewer' });
  const vault = await import('../src/lib/credentialVault.js');
  const decrypt = (evento) => JSON.parse(vault.TokenCipher.decrypt(evento.payload, vault.buildAad({ table: 'outbox_events', recordId: evento.id, field: 'payload', scope: `org:${ORG_A}`, provider: 'team_invite' })));

  const primeiroEvento = db.tables.outbox_events.find((e) => e.aggregate_id === created.body.id);
  const primeiroLink = decrypt(primeiroEvento).actionLink;

  const resent = await request(builtApp).post(`/team/invitations/${created.body.id}/resend`).set(auth('owner-token')).send({});
  expect(resent.status).toBe(200);

  // o evento antigo NUNCA sai — ficou cancelado.
  expect(primeiroEvento.status).toBe('cancelled');

  const segundoEvento = db.tables.outbox_events.find((e) => e.aggregate_id === created.body.id && e.status !== 'cancelled');
  expect(segundoEvento).toBeTruthy();
  expect(segundoEvento.id).not.toBe(primeiroEvento.id);
  const segundoLink = decrypt(segundoEvento).actionLink;
  expect(segundoLink).not.toBe(primeiroLink); // hashed_token mudou -> o link antigo (ainda que alguém tivesse o e-mail salvo) não serve mais
 });
 it('schema strict rejeita organization_id e auth user do body',async()=>{
  const res=await request(await app()).post('/team/invitations').set(auth('owner-token')).send({email:'p@x.test',role:'viewer',organization_id:ORG_B,auth_user_id:OWNER}); expect(res.status).toBe(400);
 });
 it('GET lista somente convites do tenant sem ciphertext',async()=>{
  db.tables.organization_invitations.push({id:'a',organization_id:ORG_A,email:'a@x.test',intended_role:'viewer',status:'sent'},{id:'b',organization_id:ORG_B,email:'b@x.test',intended_role:'viewer',status:'sent'});
  const res=await request(await app()).get('/team/invitations').set(auth('owner-token')); expect(res.status).toBe(200); expect(res.body.invitations.map(i=>i.id)).toEqual(['a']); expect(JSON.stringify(res.body)).not.toContain('payload');
 });
 it('cancel cross-tenant é sempre 404',async()=>{
  db.tables.organization_invitations.push({id:'foreign',organization_id:ORG_B,email:'b@x.test',intended_role:'viewer',status:'sent'});
  const res=await request(await app()).post('/team/invitations/foreign/cancel').set(auth('owner-token')).send({}); expect(res.status).toBe(404);
 });
 it('accept ignora corpo e usa somente usuário do Bearer',async()=>{
  db.tables.organization_invitations.push({id:'mine',organization_id:ORG_A,email:'i@x.test',intended_role:'viewer',status:'sent',auth_user_id:INVITED});
  const res=await request(await app()).post('/team/invitations/mine/accept').set('Authorization','Bearer invite-token').send({auth_user_id:OWNER,organization_id:ORG_B,role:'organization_owner'});
  expect(res.status).toBe(200); expect(db.client.rpc).toHaveBeenCalledWith('team_invitation_accept',expect.objectContaining({p_auth_user_id:INVITED}));
 });
});

// ===========================================================================
// BLOQUEADOR DE SEGURANÇA (revisão pós-entrega) — POST /team (rota legada)
// NUNCA pode virar um atalho pro fluxo antigo (inviteUserByEmail, sem outbox,
// sem persistência) quando o cutover de memberships está ligado. Testado
// nos dois lados: outbox ligado E desligado — nos dois casos, POST /team tem
// que estar completamente fechado, nunca cair pro legado.
// ===========================================================================
const DOC_A = 'd0000000-0000-4000-8000-000000000001';
describe('BLOQUEADOR — POST /team não pode contornar o outbox de convites', () => {
 beforeEach(() => { seed(); db.tables.doctors = [{ id: DOC_A, owner_user_id: OWNER }]; });

 it('TEAM_MEMBERSHIPS_ENABLED=true + outbox ON: POST /team nunca chama inviteUserByEmail, não cria usuário nem membership', async () => {
  const spy = vi.spyOn(db.client.auth.admin, 'inviteUserByEmail');
  const usersAntes = db.tables.users.length;
  const res = await request(await app(true, { membershipsOn: true, outboxOn: true }))
   .post('/team').set(auth('owner-token')).send({ doctor_id: DOC_A, nome: 'X', email: 'bypass1@x.test', role: 'viewer' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('use_team_invitations_endpoint');
  expect(spy).not.toHaveBeenCalled();
  expect(db.tables.users.length).toBe(usersAntes);
  expect(db.tables.memberships.some((m) => m.organization_id === ORG_A && !['m-owner'].includes(m.id))).toBe(false);
 });

 it('TEAM_MEMBERSHIPS_ENABLED=true + outbox OFF: POST /team também fechado (erro seguro, nada criado) — e /team/invitations também não existe. Nenhum caminho de convite disponível, nunca um fallback inseguro', async () => {
  const spy = vi.spyOn(db.client.auth.admin, 'inviteUserByEmail');
  const builtApp = await app(true, { membershipsOn: true, outboxOn: false });
  const resLegado = await request(builtApp).post('/team').set(auth('owner-token')).send({ doctor_id: DOC_A, nome: 'X', email: 'bypass2@x.test', role: 'viewer' });
  expect(resLegado.status).toBe(400);
  expect(resLegado.body.error).toBe('use_team_invitations_endpoint');
  const resNovo = await request(builtApp).post('/team/invitations').set(auth('owner-token')).send({ email: 'bypass2@x.test', role: 'viewer' });
  expect(resNovo.status).toBe(404); // sem o outbox ligado, a rota nova nem existe
  expect(spy).not.toHaveBeenCalled();
  expect(db.tables.organization_invitations.length).toBe(0);
  expect(db.tables.outbox_events.length).toBe(0);
 });

 it('TEAM_MEMBERSHIPS_ENABLED=false: fluxo legado continua funcionando (compatibilidade temporária) — inviteUserByEmail É chamado', async () => {
  const spy = vi.spyOn(db.client.auth.admin, 'inviteUserByEmail');
  const res = await request(await app(true, { membershipsOn: false, outboxOn: false }))
   .post('/team').set(auth('owner-token')).send({ doctor_id: DOC_A, nome: 'Legado', email: 'legado@x.test' });
  expect(res.status).toBe(201);
  // redirectTo explícito (env.FRONTEND_URL) — nunca depender da Site URL do
  // painel Supabase. Ver src/lib/authRedirect.js.
  expect(spy).toHaveBeenCalledWith('legado@x.test', expect.objectContaining({ redirectTo: expect.any(String) }));
 });

 it('chamada DIRETA e repetida ao endpoint antigo não contorna o outbox de nenhuma forma, mesmo tentando vários papéis/corpos', async () => {
  const builtApp = await app(true, { membershipsOn: true, outboxOn: true });
  for (const body of [
   { doctor_id: DOC_A, nome: 'A', email: 'a1@x.test', role: 'viewer' },
   { nome: 'B', email: 'b1@x.test', role: 'organization_admin' },
   { email: 'c1@x.test' },
   {},
  ]) {
   const res = await request(builtApp).post('/team').set(auth('owner-token')).send(body);
   expect(res.status).toBe(400);
   expect(res.body.error).toBe('use_team_invitations_endpoint');
  }
  expect(db.tables.organization_invitations.length).toBe(0);
  expect(db.tables.outbox_events.length).toBe(0);
 });
});
