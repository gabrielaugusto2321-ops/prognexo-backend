# prognexo-ip-echo (TEMPORARIO)

Servico de diagnostico para descobrir, na Render, quais valores de IP chegam ao
Express (cadeia `X-Forwarded-For`, `CF-Connecting-IP`, `CF-Ray`) e qual IP cada
estrategia escolheria. **Nao faz parte da API do Prognexo.**

- Sem dados de negocio, sem segredos, sem banco, sem variaveis de ambiente obrigatorias.
- Nao registra requisicoes e nunca devolve um IP completo: so mascara
  (`177.118.x.x`) e impressao digital (HMAC com sal aleatorio por processo).
- Endpoints: `GET /health`, `GET /echo`, `GET /bucket?strategy=cf|trust-1|trust-2|trust-3|xff-leftmost`.

## Render

- Tipo: Web Service (plano gratuito basta), branch `tmp/ip-echo-probe`.
- Build command: `npm install`
- Start command: `npm start` (`node scripts/ip-echo-server.mjs`)
- Nenhuma variavel de ambiente necessaria (a Render define `PORT`).

## Depois do teste

Apague o Web Service na Render e a branch `tmp/ip-echo-probe` do GitHub.
