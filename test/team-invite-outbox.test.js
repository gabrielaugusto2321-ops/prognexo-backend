import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV='test';
process.env.SUPABASE_URL='http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-test-key';
process.env.TEAM_INVITE_OUTBOX_ENABLED='true';
process.env.TEAM_INVITE_EMAIL_DELIVERY_ENABLED='false';
const key=Buffer.alloc(32,7).toString('base64');
const hmac=Buffer.alloc(32,8).toString('base64');
process.env.TOKEN_ENCRYPTION_KEYRING=JSON.stringify({v1:key});
process.env.TOKEN_ENCRYPTION_ACTIVE_KEY='v1';

const { TokenCipher, buildAad, __setCryptoStateForTests }=await import('../src/lib/credentialVault.js');
const { processOutboxBatch, retryAvailableAt }=await import('../src/lib/teamInviteOutbox.js');
const { fakeEmailAdapter, resendEmailAdapter, buildResendRequest }=await import('../src/lib/emailAdapter.js');

beforeAll(()=>__setCryptoStateForTests({TOKEN_ENCRYPTION_ENABLED:'false',TEAM_INVITE_OUTBOX_ENABLED:'true',TEAM_INVITE_EMAIL_DELIVERY_ENABLED:'false',TOKEN_ENCRYPTION_KEYRING:JSON.stringify({v1:key}),TOKEN_ENCRYPTION_ACTIVE_KEY:'v1'}));
afterAll(()=>__setCryptoStateForTests(null));

function fixture(id='10000000-0000-4000-8000-000000000001'){
 const org='20000000-0000-4000-8000-000000000001';
 const aad=buildAad({table:'outbox_events',recordId:id,field:'payload',scope:`org:${org}`,provider:'team_invite'});
 return {id,organization_id:org,attempt_count:1,idempotency_key:`idem-${id}`,payload:TokenCipher.encrypt(JSON.stringify({to:'only@x.test',actionLink:'https://local.test/token'}),aad)};
}

function atomicClient(events){
 const available=[...events]; const calls=[];
 return {calls,rpc:vi.fn(async(name,p)=>{
   calls.push([name,p]);
   if(name==='team_outbox_claim') return {data:available.splice(0,p.p_batch_size),error:null};
   return {data:{status:name.endsWith('sent')?'sent':'pending'},error:null};
 })};
}

describe('team invite outbox',()=>{
 it('dois workers concorrentes nunca processam o mesmo evento reivindicado atomicamente',async()=>{
   const client=atomicClient([fixture()]); const adapter=fakeEmailAdapter();
   const [a,b]=await Promise.all([
     processOutboxBatch({workerId:'w1',batchSize:1,adapter,client}),
     processOutboxBatch({workerId:'w2',batchSize:1,adapter,client}),
   ]);
   expect(a.claimed+b.claimed).toBe(1); expect(adapter.sent).toHaveLength(1);
   expect(client.calls.filter(([n])=>n==='team_outbox_mark_sent')).toHaveLength(1);
 });

 it('falha de um evento vira retry e não impede o seguinte',async()=>{
   const client=atomicClient([fixture(),fixture('10000000-0000-4000-8000-000000000002')]);
   let n=0; const adapter={sendInvitationEmail:vi.fn(async()=>{if(n++===0)throw Object.assign(new Error('secret raw message'),{code:'SMTP-DOWN'});})};
   const result=await processOutboxBatch({workerId:'w',batchSize:2,adapter,client});
   expect(result).toMatchObject({claimed:2,sent:1,retried:1,errors:1});
   const retry=client.calls.find(([name])=>name==='team_outbox_mark_retry');
   expect(retry[1].p_error_code).toBe('smtp_down');
   expect(JSON.stringify(retry)).not.toContain('secret raw message');
 });

 it('AAD errada falha fechada e não chama o adapter',async()=>{
   const e=fixture(); e.organization_id='20000000-0000-4000-8000-000000000099';
   const client=atomicClient([e]); const adapter=fakeEmailAdapter();
   const result=await processOutboxBatch({workerId:'w',adapter,client});
   expect(result.errors).toBe(1); expect(adapter.sent).toHaveLength(0);
 });

 it('fake não possui caminho de rede e Resend recusa instanciação em teste',async()=>{
   const fetchSpy=vi.spyOn(globalThis,'fetch');
   await fakeEmailAdapter().sendInvitationEmail({to:'nobody@x.test'});
   expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
   expect(()=>resendEmailAdapter({apiKey:'synthetic'})).toThrow('resend_disabled_in_test');
 });

 it('backoff é exponencial, tem jitter e respeita cap',()=>{
   const before=Date.now(); const at=new Date(retryAvailableAt(20,{baseMs:1000,maxMs:5000,random:()=>0.9})).getTime();
   expect(at-before).toBeGreaterThanOrEqual(4990); expect(at-before).toBeLessThanOrEqual(5100);
 });

 // FASE 2.7 — risco residual do outbox (at-least-once, nunca exactly-once):
 // o idempotency_key do PRÓPRIO evento (estável entre tentativas) é passado
 // pro adapter/provedor, reduzindo (não eliminando) a janela de duplicidade
 // se o processo cair entre o provedor aceitar e mark_sent persistir.
 it('adapter recebe o idempotency_key do evento — estável entre tentativas do MESMO evento', async () => {
   const client=atomicClient([fixture()]); const adapter=fakeEmailAdapter();
   await processOutboxBatch({workerId:'w',adapter,client});
   expect(adapter.sent[0].idempotencyKey).toBe('idem-10000000-0000-4000-8000-000000000001');
 });

 // buildResendRequest é puro (sem env/fetch) — testável sem nunca precisar
 // (nem poder) instanciar resendEmailAdapter() em ambiente de teste, que
 // continua recusando (teste "fake não possui..." abaixo).
 it('buildResendRequest inclui Idempotency-Key (confirmado: Resend deduplica por até 24h com essa chave)', () => {
   const { url, init } = buildResendRequest({ apiKey: 're_fake', to: 'x@x.test', actionLink: 'https://local.test/l', organizationName: 'Org', idempotencyKey: 'idem-evento-1' });
   expect(url).toBe('https://api.resend.com/emails');
   expect(init.headers['Idempotency-Key']).toBe('idem-evento-1');
 });

 it('buildResendRequest: sem idempotencyKey, não manda o header (nunca um header vazio/undefined)', () => {
   const { init } = buildResendRequest({ apiKey: 're_fake', to: 'x@x.test', actionLink: 'https://local.test/l', organizationName: 'Org' });
   expect(init.headers['Idempotency-Key']).toBeUndefined();
 });
});
