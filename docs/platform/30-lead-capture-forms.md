# Formulários universais de captação

Qualquer médico/organização autorizado cria um formulário em **Captação → Formulários**, copia o código de incorporação e recebe leads **no próprio tenant**. Nada aqui é específico de um médico: a página do Dr. Carlos é apenas o primeiro piloto.

## Arquitetura

| Peça | Onde | Papel |
|---|---|---|
| Gestão (autenticada) | `src/routes/leadForms.js` → `/lead-forms` | criar, listar, editar, desativar. Só gestão (owner/admin/manager; legado: `doctor`/`admin`). `doctor_id`/`organization_id` **nunca** vêm do corpo. |
| Público | `src/routes/publicLeadForms.js` → `/public/lead-forms/:publicId/{embed,submit}` | página do iframe e recebimento do envio. |
| Página do iframe | `src/lib/leadFormEmbedPage.js` | HTML puro (testável), tudo escapado, consentimento **desmarcado**. |
| Token do embed | `src/lib/leadFormToken.js` | HMAC ligado ao formulário + página de origem, 30 min. |
| Captura atômica | RPC `lead_form_submit` (migration 0022) | trava `(médico, telefone)`, cria/complementa o lead, garante 1 cartão no funil, grava a prova. |

Tabelas (todas com RLS ligado e sem acesso para `anon`/`authenticated`): `lead_capture_forms`, `lead_capture_form_consent_versions` (histórico imutável do texto), `lead_capture_submissions` (prova append-only).

**Não há envio de WhatsApp, e-mail, IA ou job durante a captura.** O gate de campanhas continua intacto: só seleciona `whatsapp_authorization_status = 'autorizado'`, e fora da janela de 24h só template Meta aprovado.

## Como incorporar

1. Em **Captação → Formulários**, crie o formulário e cadastre os **domínios exatos** do site (`https://drexemplo.com.br`; `www` e o domínio raiz são origens **diferentes** — cadastre ambos se o site responder nos dois).
2. Clique em **Incorporar** → **Copiar código de incorporação** e cole o HTML onde o formulário deve aparecer (qualquer construtor que aceite HTML).

O código é um `<iframe>` com `referrerpolicy="origin"` (necessário: o servidor valida a origem pelo `Referer`) e um `<script>` opcional que (a) repassa `utm_*` da página para o iframe e (b) ajusta a altura. Se o construtor removeu o `<script>`, o formulário continua funcionando — só perde o ajuste automático de altura e a atribuição por UTM (a atribuição também pode ser feita manualmente acrescentando `?utm_source=...` ao `src`).

O visual da página hospedeira não é alterado: o formulário vive isolado no iframe.

## Consentimento

- A caixa de aceite é **opcional e começa desmarcada**. O texto é versionado: editar cria uma versão nova; as antigas nunca mudam.
- Cada envio grava uma prova: texto exibido (snapshot), versão, data, origem (`lead_form:<id>`), domínio da página, UTMs, hash do IP e o resultado.
- Com aceite: lead novo nasce `autorizado`; lead `pendente` é promovido. Sem aceite: lead `pendente`, **inelegível para campanhas**.
- **Nunca** converte `opt_out`/`recusado` em autorizado (a prova registra `consent_applied=false` e o motivo), nunca sobrescreve data/fonte de uma autorização existente e nunca rebaixa um `autorizado`.
- O e-book/redirect é entregue **com ou sem** aceite. A resposta é idêntica em todos os casos (não revela se o lead já existia nem se o aceite foi ignorado).

## Duplicidade, tenant e concorrência

- O lead é buscado **somente** entre os leads do médico dono do formulário; um lead nunca troca de tenant. O mesmo telefone em outro médico vira outro lead.
- Formatos diferentes do mesmo telefone (`(11) 99999-0001`, `+55 11 …`) convergem no canônico. Leads legados sem `telefone_normalizado` são encontrados pelos dígitos do telefone bruto (e ganham o normalizado).
- Primeiro toque preservado: e-mail/UTM existentes não são sobrescritos; só campos vazios são preenchidos.
- `leads` não tem índice único por telefone; a unicidade sob concorrência vem do lock advisory da RPC.

## Segurança e limites honestos

Camadas: token HMAC (formulário + domínio, 30 min, ≥2 s de preenchimento), CSP com nonce e `frame-ancestors` **por formulário** (o navegador só deixa as origens cadastradas emoldurarem), CAPTCHA (Turnstile), honeypot, rate limits (10/min e 60/h por IP no envio; 60/min no embed; 120/min por formulário), throttle por contato (mais de 3 envios em 10 min viram `throttled`), payloads estritos.

`Referer`/`Origin` **podem ser forjados por clientes que não são navegadores**: a checagem de domínio não é autenticação. Quem escreve um script pode obter um token do embed enviando o `Referer` certo. O que limita o dano é a combinação CAPTCHA + rate limit + throttle por contato + token curto — não o domínio isoladamente.

**Pré-visualização:** o painel (`FRONTEND_URL`) pode emoldurar qualquer formulário, mas os envios feitos dali validam tudo e **não criam lead** (não polui o CRM do médico).

## CAPTCHA (Cloudflare Turnstile) — prontidão

Provedor implementado: **Turnstile** (o único suportado por `src/lib/captcha.js`).

| Onde | Variável | Observação |
|---|---|---|
| Render (backend) | `CAPTCHA_ENABLED=true` | em `production`/`staging` o servidor **nem sobe** sem isto e sem o secret (`env.js`) |
| Render (backend) | `CAPTCHA_SECRET` | secret do Turnstile; nunca vai ao navegador |
| Render (backend) | `CAPTCHA_PROVIDER=turnstile` | é o default |
| Render (backend) | **`CAPTCHA_SITE_KEY`** (nova) | chave **pública** do widget. É a única que provavelmente falta |
| Frontend/Vercel | nenhuma | o widget roda dentro do iframe servido pela API, não no frontend |

Fluxo: o iframe renderiza `<div class="cf-turnstile" data-sitekey="CAPTCHA_SITE_KEY">` → o widget preenche `cf-turnstile-response` → o script envia como `captcha_token` → o backend faz `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` com `secret`, `response` e `remoteip`. Falha de rede, resposta de erro ou `success:false` = recusa (fail-closed).

No painel da Cloudflare, a lista de **hostnames** do widget deve conter o hostname **da API** (o iframe é servido por ela), e **não** o do site do médico.

Se a configuração estiver incompleta em produção (ex.: falta `CAPTCHA_SITE_KEY`), o embed responde **503 "Formulário temporariamente indisponível"** e registra o motivo no log — em vez de mostrar um formulário que nenhum visitante conseguiria enviar.

## Pré-requisitos de produção

1. Aplicar manualmente a migration `0022` (não aplicada por esta entrega). **Colisão de numeração:** a branch `product/crm-automation-engine` também usa `0022` (`crm_lead_attachments`) e já diverge desta linha em 0019–0021. Quem for mesclado depois precisa renumerar. Ao unir as linhas, a busca por telefone da RPC deve ignorar leads mesclados (`leads.merged_into_lead_id`, criado em `0020_crm_data_operations` daquela branch; a coluna ainda não existe aqui).
2. Configurar `CAPTCHA_SITE_KEY` no Render (seção acima) e cadastrar o hostname da API no widget.
3. Conferir `FRONTEND_URL` (define a origem da pré-visualização).
4. `LEAD_FORM_EMBED_SECRET` é opcional; sem ele a chave é derivada da service role key.

## Sites de terceiros (construtores de página)

`frame-ancestors` vale para **toda a cadeia de ancestrais**: se o construtor embute a sua página dentro de outro iframe (comum em "blocos de código/embed"), a origem do **topo** e a do iframe intermediário precisam estar todas em `allowed_origins`, senão o navegador bloqueia. Além disso o `Referer` recebido pelo embed é o da página que contém o iframe, que em alguns construtores é um domínio de sandbox (não o domínio público). **Teste com o site real e descubra a origem efetiva antes de anunciar compatibilidade.** Compatibilidade com um construtor específico não está comprovada por testes automáticos.

## IP real e limites (PROVAR antes de ligar qualquer coisa)

**Defeito medido em produção** (`/health`, contador `ratelimit-remaining`, uma única máquina): `298, 297, 296, 298, 297, 296, 295, 294` — o contador pula entre baldes. Com `trust proxy = 1` o Express recebe o IP de uma **borda do Cloudflare**, que varia entre requisições. Consequências: o limite de um visitante fica diluído (mais fraco que o desenhado) e visitantes na mesma borda dividem um balde.

**Provado num serviço de teste real da Render** (`scripts/ip-echo-server.mjs`, commit `e6db755`; 3 execuções de `scripts/ip-probe.mjs` + 40 requisições espalhadas por ~1 min; IPs sempre mascarados):

- **Cadeia que chega ao Express**, da conexão para fora: socket IPv6 da Render → `10.x.x.x` (hop interno da Render, varia) → `172.69–71.x.x` (borda do Cloudflare, varia) → **IP real do visitante**. `X-Forwarded-For` tem 3 entradas e o cliente é sempre a **3ª da direita** (40/40).
- **Configuração atual (`trust proxy = 1`) escolhe o cliente em 0/40**: usa o hop interno da Render. Logo TODOS os visitantes compartilham a mesma chave de rate limit, e ela varia com o tempo (`10.28`, `10.29`, `10.31`…). Defeito real, não só diluição.
- **`CF-Connecting-IP`**: presente em 40/40, igual ao IP real em 40/40, 1 único valor; `CF-Ray` 40/40; `True-Client-IP` também correto.
- **Forjado não chega**: a borda do Cloudflare responde **403** (página de bloqueio do Cloudflare, sem tocar a Render) a qualquer requisição que traga `CF-Connecting-IP` enviado pelo cliente. Um `X-Forwarded-For` forjado chega, mas fica **à esquerda** do cliente (não muda a posição 3). `True-Client-IP`/`X-Real-IP` forjados não alteram nada do que o Express usa.
- **Baldes**: com `CF-Connecting-IP` e com 3 saltos, o mesmo visitante cai numa sequência única e requisições forjadas não criam balde novo.

**Decisão:** ligar `TRUST_CLOUDFLARE_HEADERS=true` (com `TRUST_PROXY_HOPS=1`). O header falha de forma segura — se a Render deixar de enviá-lo, o app volta ao comportamento atual. `TRUST_PROXY_HOPS=3` também é seguro **hoje**, mas falha em silêncio se a cadeia mudar de tamanho; fica como plano B. **Não alterar a produção sem autorização** e repetir a medição do `/health` depois (sequência única `299, 298, 297…`).

**Duas estratégias, ambas DESLIGADAS por padrão** (produção segue igual até a prova):

| Estratégia | Variável | Quando usar |
|---|---|---|
| Contar saltos do `X-Forwarded-For` | `TRUST_PROXY_HOPS=N` (padrão 1) | a sonda mostra o cliente na posição N da direita e um prefixo forjado fica à esquerda |
| Header do Cloudflare | `TRUST_CLOUDFLARE_HEADERS=true` | a sonda mostra `CF-Connecting-IP` + `CF-Ray` sempre presentes, IP real, e o valor forjado NÃO chega |

Se `CF-Connecting-IP` puder ser controlado pelo cliente ou não chegar de forma consistente, **não usar** o header; a contagem de saltos não depende dele.

**Como provar (serviço de teste, sem tocar na produção):**
1. Criar um Web Service **separado** na Render a partir deste repositório, com `start command: node scripts/ip-echo-server.mjs` (mesma entrada: Cloudflare → balanceador → app). Ele não tem dados nem segredos, não faz log de requisição e só devolve IPs mascarados + impressão digital.
2. Rodar `node scripts/ip-probe.mjs https://<servico-de-teste>.onrender.com`. A sonda envia requisições normais e com `CF-Connecting-IP`, `X-Forwarded-For`, `True-Client-IP` e `X-Real-IP` forjados (IPs de documentação `198.51.100.x`), e imprime só máscaras, booleanos e a **recomendação**.
3. Aplicar a recomendação **no serviço de produção só depois**, e repetir a medição no `/health`: o contador do mesmo visitante deve ser uma sequência única (`299, 298, 297…`).
4. Derrubar o serviço de teste.

A sonda e o servidor de eco são testados contra cadeias simuladas (`test/ip-probe.test.js`); isso valida a lógica de decisão, **não substitui** a prova no serviço real.

O limite por formulário (120/min) e o throttle por contato (mais de 3 envios em 10 min) continuam valendo em qualquer cenário.

## Retenção e exclusão de tenant

A prova de consentimento usa `on delete restrict` de propósito: excluir um formulário ou um médico **não** leva a prova junto. Para excluir um tenant, apague explicitamente antes, na ordem: `lead_capture_submissions` → `lead_capture_form_consent_versions` → `lead_capture_forms` — decisão que precisa considerar a política jurídica de retenção.

## Rollback

Desative os formulários, exporte as provas conforme a política jurídica e rode `migrations/0022_lead_capture_forms.rollback.sql`. Remove exatamente a função e as 3 tabelas (validado em Postgres 17.6 real: nenhum outro objeto e nenhum dado de `leads`/`deals` é tocado). É destrutivo para as provas armazenadas.

## Fora de escopo (fase futura, desativada por padrão)

Pixel/CAPI: exige Pixel ID e token de CAPI próprios de cada médico, que ainda não existem no sistema. Não há colunas, código ou eventos para isso.
