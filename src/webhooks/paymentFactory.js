import { Router } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { safeEqual, verifyHmac } from '../lib/signatures.js';
import {
  normalizeStatus,
  registrarTransacao,
  encontrarDealPorContato,
  resolveDoctorFromToken,
  claimWebhookEvent,
} from '../lib/salesWebhook.js';
import { webhookIdempotencyReady } from '../lib/readiness.js';

// Fábrica de webhook de pagamento. Cada provedor passa:
//  - provider:   nome interno ('pagarme' | 'kiwify' | 'hotmart' | 'ticto')
//  - secretEnv:  nome da env var com o segredo de verificação
//  - parse:      (body) => { id, eventId, status, valor, email, telefone, method, dealId? }
//  - signature:  ({ req, secret }) => boolean   (verificador de assinatura do provedor)
//  - requireEnabledEnv: (opcional) env var que precisa ser 'true' para o endpoint
//                       funcionar em produção — usado quando o provedor NÃO tem
//                       assinatura criptográfica (ex.: Ticto).
export function paymentWebhook({ provider, secretEnv, parse, signature, requireEnabledEnv }) {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      // Master switch: webhooks de pagamento desligados em produção por padrão
      // (só ligar quando a assinatura de cada provedor tiver sido verificada
      // contra doc oficial + fixtures reais — ver docs/platform/WEBHOOKS.md).
      if (env.NODE_ENV === 'production' && env.PAYMENT_WEBHOOKS_ENABLED !== 'true') {
        return res.status(503).json({ error: 'webhook_disabled' });
      }

      // Provedor sem assinatura criptográfica (Ticto) tem gate próprio adicional.
      if (
        requireEnabledEnv &&
        env.NODE_ENV === 'production' &&
        env[requireEnabledEnv] !== 'true'
      ) {
        return res.status(503).json({ error: 'webhook_disabled' });
      }

      // Sem idempotência durável (tabela webhook_events / migration 0005) não
      // processamos em produção — evita cobrança/fechamento duplicado.
      if (env.NODE_ENV === 'production' && !(await webhookIdempotencyReady())) {
        return res.status(503).json({ error: 'webhook_not_ready' });
      }

      // Roteamento por tenant: token no header (novo) ou ?secret= (legado, deprecado).
      const legacyToken = req.query.secret;
      const token = req.get('X-Prognexo-Webhook-Token') || legacyToken;
      if (legacyToken) logger.warn({ provider }, 'Deprecated webhook query token used');

      const doctorId = await resolveDoctorFromToken(provider, token);
      if (!doctorId) return res.status(401).json({ error: 'unauthorized' });

      // Verificação de assinatura do provedor sobre o corpo bruto.
      const secret = env[secretEnv];
      const signatureValid = signature({ req, secret });
      const enforce = env.NODE_ENV === 'production' && env.PAYMENT_WEBHOOKS_ENFORCE_SIGNATURE === 'true';
      if (enforce && !signatureValid) return res.status(401).json({ error: 'invalid_signature' });

      const event = parse(req.body);
      if (!event.id || !event.status) return res.status(400).json({ error: 'invalid_payload' });

      // Idempotência: se o evento já foi recebido, responde OK sem reprocessar.
      const claimId = await claimWebhookEvent({
        provider,
        externalEventId: event.eventId || event.id,
        signatureValid,
        rawBody: req.rawBody,
      });
      if (!claimId) return res.status(200).json({ ok: true, replayed: true });

      const dealId =
        event.dealId || (await encontrarDealPorContato({ email: event.email, telefone: event.telefone, doctorId }));

      await registrarTransacao({
        gateway: provider,
        gatewayTransactionId: event.id,
        valor: event.valor,
        status: normalizeStatus(event.status),
        metodoPagamento: event.method,
        dealId,
        doctorId,
        eventId: event.eventId || event.id,
      });

      return res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

// HMAC-SHA1 sobre o corpo bruto (Kiwify e Pagar.me). O valor recebido pode vir
// no header indicado ou na query `signature` (compatibilidade com URLs antigas).
export const hmacSha1 = (header, prefix = '') => ({ req, secret }) =>
  verifyHmac({
    algorithm: 'sha1',
    secret,
    rawBody: req.rawBody,
    provided: req.get(header) || req.query.signature,
    prefix,
  });

// Token estático comparado em tempo constante (Hotmart hottok). NÃO é assinatura
// criptográfica — não protege o conteúdo, só a origem.
export const staticToken = (header, bodyKey) => ({ req, secret }) =>
  safeEqual(req.get(header) || req.body?.[bodyKey], secret);
