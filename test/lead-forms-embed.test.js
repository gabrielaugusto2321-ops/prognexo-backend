import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const envState = { SUPABASE_SERVICE_ROLE_KEY: 'test-key', LEAD_FORM_EMBED_SECRET: undefined };
vi.mock('../src/config/env.js', () => ({ env: envState }));
const { createLeadFormToken, verifyLeadFormToken } = await import('../src/lib/leadFormToken.js');
const { buildLeadFormEmbedPage } = await import('../src/lib/leadFormEmbedPage.js');

const FORM = {
  public_id: 'lf_a', name: 'Ebook', consent_text: 'Aceito receber mensagens.', redirect_url: 'https://a.test/ebook.pdf', success_message: 'Obrigado!',
};
const page = (over = {}) => buildLeadFormEmbedPage({ form: FORM, token: 'tok.sig', nonce: 'n0nce', utm: { utm_source: 'ig' }, ...over });

describe('token do embed', () => {
  it('assina, amarra ao formulário e ao domínio, e expira', () => {
    const now = 1_700_000_000_000;
    const token = createLeadFormToken({ pid: 'lf_a', host: 'https://a.test', now });
    expect(verifyLeadFormToken(token, { pid: 'lf_a', now: now + 2000 })?.host).toBe('https://a.test');
    expect(verifyLeadFormToken(token, { pid: 'lf_b', now: now + 2000 })).toBeNull();
    expect(verifyLeadFormToken(`${token}x`, { pid: 'lf_a', now: now + 2000 })).toBeNull();
    expect(verifyLeadFormToken(token, { pid: 'lf_a', now: now + 1_900_000 })).toBeNull();
  });

  it('token com payload alterado (host trocado) não valida', () => {
    const token = createLeadFormToken({ pid: 'lf_a', host: 'https://a.test' });
    const [, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ pid: 'lf_a', host: 'https://evil.test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 1800 })).toString('base64url');
    expect(verifyLeadFormToken(`${forged}.${signature}`, { pid: 'lf_a' })).toBeNull();
  });

  it('secret próprio muda a assinatura (override opcional)', () => {
    const token = createLeadFormToken({ pid: 'lf_a', host: 'https://a.test' });
    envState.LEAD_FORM_EMBED_SECRET = 'outro-segredo';
    expect(verifyLeadFormToken(token, { pid: 'lf_a' })).toBeNull();
    envState.LEAD_FORM_EMBED_SECRET = undefined;
    expect(verifyLeadFormToken(token, { pid: 'lf_a' })).not.toBeNull();
  });
});

describe('HTML da página do iframe', () => {
  it('escapa nome e texto de consentimento hostis e mantém o aceite DESMARCADO', () => {
    const html = page({ form: { ...FORM, name: '<script>x</script>', consent_text: '"><img src=x onerror=alert(1)>' } });
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('name="website"');
    expect(html).toContain('prognexo:lead-form:height');
    expect(html).not.toMatch(/name="consent"[^>]*checked/);
    expect(html).not.toContain('innerHTML');
  });

  it('config no script escapa "<" (sem fechar a tag por dentro)', () => {
    const html = page({ form: { ...FORM, success_message: '</script><script>alert(1)</script>' } });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('só carrega o Turnstile quando habilitado, com nonce e site key escapada', () => {
    expect(page()).not.toContain('challenges.cloudflare.com');
    const withCaptcha = page({ captchaEnabled: true, captchaSiteKey: '"><x' });
    expect(withCaptcha).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
    expect(withCaptcha).toContain('data-sitekey="&quot;&gt;&lt;x"');
    expect(withCaptcha).toContain('<script nonce="n0nce" src="https://challenges.cloudflare.com');
  });

  it('pré-visualização avisa que não grava; página normal não avisa', () => {
    expect(page({ preview: true })).toContain('não são registrados como leads');
    expect(page()).not.toContain('não são registrados como leads');
  });

  it('nunca carrega ids internos nem segredos', () => {
    const html = page();
    for (const forbidden of ['doctor_id', 'organization_id', 'service_role', 'SUPABASE', 'test-key']) expect(html).not.toContain(forbidden);
  });
});

// Executa o JavaScript do iframe de verdade, num DOM mínimo.
function runPage({ fetchImpl, consent = false, redirect = FORM.redirect_url } = {}) {
  const html = page({ form: { ...FORM, redirect_url: redirect } });
  const script = html.match(/<script nonce="n0nce">([\s\S]*)<\/script><\/body>/)[1];
  const button = { disabled: false };
  const result = { textContent: '', style: { display: 'none' }, children: [], append(...nodes) { this.children.push(...nodes); } };
  const listeners = {};
  const form = { hidden: false, addEventListener: (type, fn) => { listeners[type] = fn; }, querySelector: () => button };
  const values = { nome: 'Maria', email: 'm@x.com', telefone: '11999990001', website: '', ...(consent ? { consent: 'on' } : {}) };
  const top = { location: { replace: vi.fn() } };
  const parent = { postMessage: vi.fn() };
  const context = {
    cfg: undefined,
    document: {
      getElementById: (id) => (id === 'lead-form' ? form : result),
      querySelector: () => null,
      documentElement: { scrollHeight: 321 },
      body: {},
      createElement: (tag) => ({ tag, style: {} }),
    },
    FormData: class { get(name) { return values[name] ?? null; } },
    ResizeObserver: class { observe() {} },
    addEventListener: () => {},
    location: { href: 'https://a.test/pagina' },
    window: { top },
    parent,
    fetch: fetchImpl,
    encodeURIComponent, JSON, Promise,
  };
  vm.runInNewContext(script, context);
  const submit = () => listeners.submit({ preventDefault: () => {} });
  return { submit, button, result, form, top, parent };
}
const ok = (body) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));

describe('JavaScript do iframe', () => {
  it('sem marcar o aceite envia consent=false, com token, UTMs e honeypot vazio', async () => {
    const fetchImpl = ok({ message: 'Obrigado!', redirect_url: null });
    const { submit } = runPage({ fetchImpl });
    await submit();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/public/lead-forms/lf_a/submit');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ consent: false, embed_token: 'tok.sig', website: '', utm: { utm_source: 'ig' }, page_url: 'https://a.test/pagina' });
  });

  it('marcando o aceite envia consent=true', async () => {
    const fetchImpl = ok({ message: 'ok', redirect_url: null });
    await runPage({ fetchImpl, consent: true }).submit();
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).consent).toBe(true);
  });

  it('nunca envia ids do médico/organização no corpo', async () => {
    const fetchImpl = ok({ message: 'ok', redirect_url: null });
    await runPage({ fetchImpl, consent: true }).submit();
    expect(Object.keys(JSON.parse(fetchImpl.mock.calls[0][1].body)).sort())
      .toEqual(['consent', 'email', 'embed_token', 'nome', 'page_url', 'telefone', 'utm', 'website']);
  });

  it('sucesso com redirect: esconde o formulário, mostra a mensagem, oferece o link e tenta redirecionar o topo', async () => {
    const { submit, form, result, top } = runPage({ fetchImpl: ok({ message: 'Obrigado!', redirect_url: 'https://a.test/ebook.pdf' }) });
    await submit();
    expect(form.hidden).toBe(true);
    expect(result.textContent).toBe('Obrigado!');
    expect(result.children.find((n) => n.tag === 'a')).toMatchObject({ href: 'https://a.test/ebook.pdf', target: '_blank', rel: 'noopener' });
    expect(top.location.replace).toHaveBeenCalledWith('https://a.test/ebook.pdf');
  });

  it('o e-book sai IGUAL com ou sem aceite (o cliente só reage ao redirect_url da resposta)', async () => {
    const body = { message: 'Obrigado!', redirect_url: 'https://a.test/ebook.pdf' };
    const semAceite = runPage({ fetchImpl: ok(body), consent: false });
    const comAceite = runPage({ fetchImpl: ok(body), consent: true });
    await semAceite.submit(); await comAceite.submit();
    expect(semAceite.top.location.replace).toHaveBeenCalledWith(body.redirect_url);
    expect(comAceite.top.location.replace).toHaveBeenCalledWith(body.redirect_url);
  });

  it('sem redirect configurado não cria link nem redireciona', async () => {
    const { submit, result, top } = runPage({ fetchImpl: ok({ message: 'Obrigado!', redirect_url: null }), redirect: null });
    await submit();
    expect(result.children).toHaveLength(0);
    expect(top.location.replace).not.toHaveBeenCalled();
  });

  it('redirecionar o topo bloqueado pelo navegador não quebra (o link continua)', async () => {
    const { submit, top, result } = runPage({ fetchImpl: ok({ message: 'ok', redirect_url: 'https://a.test/e' }) });
    top.location.replace.mockImplementation(() => { throw new Error('blocked'); });
    await expect(submit()).resolves.not.toThrow();
    expect(result.children.some((n) => n.tag === 'a')).toBe(true);
  });

  it('trava o botão durante o envio: duplo clique dispara UMA requisição', async () => {
    let release;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ message: 'ok', redirect_url: null }) }); }));
    const { submit, button } = runPage({ fetchImpl });
    const first = submit();
    await submit();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    release();
    await first;
  });

  it('erro 400 reabilita o botão e pede conferência dos dados', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }));
    const { submit, button, result } = runPage({ fetchImpl });
    await submit();
    expect(button.disabled).toBe(false);
    expect(result.textContent).toMatch(/Confira os dados/);
  });

  it.each([[403, /expirou/], [429, /Muitas tentativas/], [500, /Não foi possível enviar/]])('erro %s mostra a orientação certa e reabilita o botão', async (status, message) => {
    const { submit, button, result } = runPage({ fetchImpl: vi.fn(async () => ({ ok: false, status, json: async () => ({}) })) });
    await submit();
    expect(button.disabled).toBe(false);
    expect(result.textContent).toMatch(message);
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'http://a.test/e', '//evil.test/x', 5, {}])('redirect não-https na resposta (%s) nunca vira link nem redirecionamento', async (dangerous) => {
    const { submit, result, top } = runPage({ fetchImpl: ok({ message: 'Obrigado!', redirect_url: dangerous }) });
    await submit();
    expect(result.textContent).toBe('Obrigado!');
    expect(result.children).toHaveLength(0);
    expect(top.location.replace).not.toHaveBeenCalled();
  });

  it('falha de rede não deixa o botão travado nem estoura', async () => {
    const { submit, button, result } = runPage({ fetchImpl: vi.fn(async () => { throw new Error('offline'); }) });
    await expect(submit()).resolves.not.toThrow();
    expect(button.disabled).toBe(false);
    expect(result.textContent).toMatch(/Sem conexão/);
  });

  it('avisa a página hospedeira da altura (postMessage) ao renderizar o resultado', async () => {
    const { submit, parent } = runPage({ fetchImpl: ok({ message: 'ok', redirect_url: null }) });
    await submit();
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'prognexo:lead-form:height', height: 321 }, '*');
  });
});
