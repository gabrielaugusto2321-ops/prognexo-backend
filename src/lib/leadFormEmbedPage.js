function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Página do iframe do formulário de captação. Função PURA (testável sem
// navegador). Tudo que veio do médico (nome, texto de consentimento, mensagem,
// URL) entra escapado no HTML ou como JSON com `<` escapado — nunca cru.
export function buildLeadFormEmbedPage({
  form, token, nonce, utm = {}, captchaEnabled = false, captchaSiteKey = '', preview = false,
}) {
  const config = JSON.stringify({
    publicId: form.public_id,
    token,
    utm,
    redirectUrl: form.redirect_url || null,
    successMessage: form.success_message || 'Obrigado! Recebemos seus dados.',
  }).replace(/</g, '\\u003c');

  const captcha = captchaEnabled
    ? `<div class="cf-turnstile" data-sitekey="${esc(captchaSiteKey)}"></div><script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : '';
  const previewNote = preview
    ? '<p class="note" role="note">Pré-visualização: os envios feitos aqui não são registrados como leads.</p>'
    : '';

  const style = 'body{font:16px system-ui,sans-serif;margin:0;padding:16px;color:#171717}'
    + 'form{display:grid;gap:12px}label{display:grid;gap:4px}'
    + 'input,button{font:inherit;padding:10px;box-sizing:border-box}'
    + 'button{cursor:pointer}button[disabled]{cursor:progress;opacity:.7}'
    + '.consent{display:flex;gap:8px;align-items:flex-start}.consent input{margin-top:4px}'
    + '.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}'
    + '.note{margin:0 0 12px;font-size:14px;color:#555}#result{display:none}';

  const script = `const cfg=${config};
const form=document.getElementById('lead-form'),result=document.getElementById('result'),button=form.querySelector('button[type=submit]');
function height(){parent.postMessage({type:'prognexo:lead-form:height',height:document.documentElement.scrollHeight},'*')}
addEventListener('load',height);
new ResizeObserver(height).observe(document.body);
function show(text){result.textContent=text;result.style.display='block';height()}
form.addEventListener('submit',async(event)=>{
  event.preventDefault();
  if(button.disabled)return;
  button.disabled=true;
  const data=new FormData(form),captcha=document.querySelector('[name="cf-turnstile-response"]');
  const body={nome:data.get('nome'),email:data.get('email'),telefone:data.get('telefone'),consent:data.get('consent')==='on',embed_token:cfg.token,website:data.get('website')||'',utm:cfg.utm,page_url:location.href};
  if(captcha&&captcha.value)body.captcha_token=captcha.value;
  try{
    const response=await fetch('/public/lead-forms/'+encodeURIComponent(cfg.publicId)+'/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(!response.ok){
      button.disabled=false;
      const reasons={400:'Confira os dados informados e tente novamente.',403:'Esta página expirou. Recarregue e tente novamente.',429:'Muitas tentativas. Aguarde um minuto e tente novamente.'};
      show(reasons[response.status]||'Não foi possível enviar. Tente novamente.');
      return
    }
    const done=await response.json();
    form.hidden=true;
    show(done.message);
    if(typeof done.redirect_url==='string'&&/^https:\\/\\//.test(done.redirect_url)){
      const link=document.createElement('a');
      link.href=done.redirect_url;link.target='_blank';link.rel='noopener';link.textContent='Acessar o material';
      result.append(document.createElement('br'),link);
      try{window.top.location.replace(done.redirect_url)}catch(e){}
    }
    height();
  }catch(e){button.disabled=false;show('Sem conexão. Tente novamente.')}
});`;

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(form.name)}</title><style nonce="${nonce}">${style}</style></head><body><main><h1>${esc(form.name)}</h1>${previewNote}<form id="lead-form"><label>Nome<input name="nome" required minlength="2" maxlength="120" autocomplete="name"></label><label>E-mail<input name="email" type="email" required autocomplete="email"></label><label>WhatsApp<input name="telefone" type="tel" required maxlength="30" autocomplete="tel"></label><label class="consent"><input name="consent" type="checkbox"><span>${esc(form.consent_text)}</span></label><label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>${captcha}<button type="submit">Enviar</button></form><div id="result" role="status"></div></main><script nonce="${nonce}">${script}</script></body></html>`;
}
