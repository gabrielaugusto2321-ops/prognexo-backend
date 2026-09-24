import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { env } from './config/env.js';
import { clientIp } from './middleware/clientIp.js';
import { logger } from './lib/logger.js';
import {
  assertRateLimitStoreReady,
  globalLimiter,
  authLimiter,
  checkoutLimiter,
  aiLimiter,
  webhookLimiter,
} from './middleware/rateLimits.js';

import leadsRoutes from './routes/leads.js';
import dealsRoutes from './routes/deals.js';
import dashboardRoutes from './routes/dashboard.js';
import teamRoutes from './routes/team.js';
import teamInvitationRoutes from './routes/teamInvitations.js';
import doctorsRoutes from './routes/doctors.js';
import adminDoctorsRoutes from './routes/adminDoctors.js';
import signupRoutes from './routes/signup.js';
import activationRoutes from './routes/activation.js';
import integrationsRoutes from './routes/integrations.js';
import jobsRoutes from './routes/jobs.js';
import eventsRoutes from './routes/events.js';
import googleAuthRoutes from './routes/googleAuth.js';
import reportsRoutes from './routes/reports.js';
import patientsRoutes from './routes/patients.js';
import onboardingRoutes from './routes/onboarding.js';
import conversationsRoutes from './routes/conversations.js';
import planosRoutes from './routes/planos.js';
import playgroundRoutes from './routes/playground.js';
import knowledgeBaseRoutes from './routes/knowledgeBase.js';
import bdrRoutes from './routes/bdr.js';
import campanhasRoutes from './routes/campanhas.js';
import tenantRoutes from './routes/tenant.js';
import leadFormsRoutes from './routes/leadForms.js';
import publicLeadFormsRoutes from './routes/publicLeadForms.js';

import whatsappWebhook from './webhooks/whatsapp.js';
import pagarmeWebhook from './webhooks/pagarme.js';
import kiwifyWebhook from './webhooks/kiwify.js';
import hotmartWebhook from './webhooks/hotmart.js';
import tictoWebhook from './webhooks/ticto.js';

// Rotas montadas sem middleware extra (o rate-limit global já cobre todas).
const ROUTE_MOUNTS = [
  ['/leads', leadsRoutes],
  ['/deals', dealsRoutes],
  ['/dashboard', dashboardRoutes],
  ['/team/invitations', teamInvitationRoutes],
  ['/team', teamRoutes],
  ['/doctors', doctorsRoutes],
  ['/admin/doctors', adminDoctorsRoutes],
  ['/signup', signupRoutes],
  ['/activation', activationRoutes],
  ['/integrations', integrationsRoutes],
  ['/jobs', jobsRoutes],
  ['/events', eventsRoutes],
  ['/auth/google', googleAuthRoutes],
  ['/reports', reportsRoutes],
  ['/patients', patientsRoutes],
  ['/onboarding', onboardingRoutes],
  ['/conversations', conversationsRoutes],
  ['/knowledge-base', knowledgeBaseRoutes],
  ['/bdr', bdrRoutes],
  ['/campanhas', campanhasRoutes],
  ['/tenant', tenantRoutes],
  ['/lead-forms', leadFormsRoutes],
  ['/public/lead-forms', publicLeadFormsRoutes],
];

export function createApp() {
  const app = express();

  // Atrás do CDN/proxy: quantos hops confiar para ler o IP real (rate-limit).
  // Padrão 1 (histórico). Ver TRUST_PROXY_HOPS em config/env.js.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  // Com TRUST_CLOUDFLARE_HEADERS=true, req.ip vira o IP real (CF-Connecting-IP)
  // em vez do IP da borda do Cloudflare. Antes de qualquer rate limit.
  app.use(clientIp);

  const allowedOrigins = (env.CORS_ALLOWED_ORIGINS || env.FRONTEND_URL || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  app.use(helmet({ contentSecurityPolicy: false })); // a API não serve HTML
  const corsOptions = {
    credentials: false, // autenticação é por Bearer token, nunca cookie
    origin(origin, cb) {
      // Sem Origin = chamada servidor-a-servidor (webhook, curl) — permitida.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      const error = new Error('cors_denied');
      error.status = 403;
      cb(error);
    },
  };
  app.use(
    cors((req, optionsCb) => {
      // Formulários de captação: a página do iframe é servida por esta própria
      // API, então o POST é same-origin (o navegador manda Origin = esta API).
      // Sem CORS aqui, e sem rejeitar; o controle de quem pode usar o formulário
      // é o embed token + frame-ancestors, não o CORS.
      if (req.path.startsWith('/public/lead-forms')) return optionsCb(null, { origin: false });
      return optionsCb(null, corsOptions);
    })
  );

  // Guarda o corpo bruto para verificação de assinatura HMAC dos webhooks.
  app.use(
    express.json({
      limit: '100kb',
      verify(req, _res, buf) {
        req.rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Log estruturado com request-id. A redação de segredos/PII vem do logger.
  app.use(
    pinoHttp({
      logger,
      genReqId(req, res) {
        const inbound = req.headers['x-request-id'];
        const id = typeof inbound === 'string' && inbound.length <= 100 ? inbound : crypto.randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customProps(req) {
        return { path: req.path };
      },
      autoLogging: { ignore: (req) => req.path === '/health' },
      serializers: {
        req(req) {
          // Nunca logar a query string (pode conter ?secret= legado).
          return { id: req.id, method: req.method, path: req.raw?.path || req.url?.split('?')[0] };
        },
      },
    })
  );

  // Timeout de request — aborta chamadas presas em vez de segurar o worker.
  app.use((req, res, next) => {
    res.setTimeout(20_000, () => {
      if (!res.headersSent) res.status(503).json({ error: 'request_timeout', requestId: req.id });
    });
    next();
  });

  app.use(globalLimiter);
  app.use('/auth', authLimiter);

  for (const [mountPath, router] of ROUTE_MOUNTS) app.use(mountPath, router);

  // Rotas com rate-limit mais apertado (custo externo).
  app.use('/planos', checkoutLimiter, planosRoutes);
  app.use('/playground', aiLimiter, playgroundRoutes);

  app.use('/webhooks', webhookLimiter);
  app.use('/webhooks/whatsapp', whatsappWebhook);
  app.use('/webhooks/pagarme', pagarmeWebhook);
  app.use('/webhooks/kiwify', kiwifyWebhook);
  app.use('/webhooks/hotmart', hotmartWebhook);
  app.use('/webhooks/ticto', tictoWebhook);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use((req, res) => res.status(404).json({ error: 'not_found', requestId: req.id }));

  // Handler central: nunca vaza stack/mensagem interna para o cliente.
  app.use((err, req, res, _next) => {
    req.log?.error({ err }, 'Request failed');
    // Erros do body-parser (JSON malformado, corpo grande) e o CORS já trazem
    // um status 4xx correto — repassa. Qualquer outra coisa vira 500 genérico.
    const raw = Number(err.status || err.statusCode);
    const status = Number.isInteger(raw) && raw >= 400 && raw < 500 ? raw : 500;
    const codes = { 400: 'bad_request', 403: 'forbidden', 413: 'payload_too_large', 415: 'unsupported_media_type' };
    res.status(status).json({ error: codes[status] || (status === 500 ? 'internal_error' : 'request_error'), requestId: req.id });
  });

  return app;
}

export const app = createApp();

if (process.env.NODE_ENV !== 'test') {
  // Falha explícita (não silenciosa) se o rate-limit não puder proteger esta topologia.
  assertRateLimitStoreReady();
  const port = process.env.PORT || 3333;
  const server = app.listen(port, () => logger.info({ port }, 'Prognexo backend started'));
  server.requestTimeout = 25_000;
  server.headersTimeout = 30_000;
}
