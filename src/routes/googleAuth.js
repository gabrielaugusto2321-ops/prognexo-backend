import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { buildAuthUrl, trocarCodigoPorTokens, estaConectado } from '../lib/googleCalendar.js';
import { createOAuthState, consumeOAuthState, isAllowedRedirectBase } from '../lib/oauthState.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const router = Router();

const FLOW = 'google_calendar';

// Redireciona o navegador de volta ao frontend com um status na querystring do
// hash — mas SÓ se a base do frontend estiver na allowlist (R06). Se a config
// estiver errada, responde um erro simples em vez de mandar o navegador para fora.
function sendFrontendRedirect(res, status, fallbackHttpStatus, fallbackBody) {
  const base = env.FRONTEND_URL || 'https://prognexo-frontend.vercel.app';
  if (isAllowedRedirectBase(base)) {
    return res.redirect(`${base}/#/agenda?google=${status}`);
  }
  // Base fora da allowlist: não redireciona para fora — responde JSON.
  const body = fallbackHttpStatus >= 400 ? { error: fallbackBody } : { ok: true };
  return res.status(fallbackHttpStatus).json(body);
}

// GET /auth/google/connect — devolve a URL de autorização do Google.
// O `state` é um nonce opaco; o contexto (usuário) fica no servidor.
router.get('/connect', requireAuth, (req, res) => {
  const state = createOAuthState({ userId: req.user.id, role: req.user.role, flow: FLOW });
  res.json({ url: buildAuthUrl(state) });
});

// GET /auth/google/callback — o Google chama esta rota após a autorização.
// NÃO exige login (o navegador chega direto do Google). A identidade vem
// EXCLUSIVAMENTE do state consumido no servidor — nada do query string.
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  const ctx = consumeOAuthState(state, FLOW);
  if (!ctx) {
    // state ausente, desconhecido, expirado, de outro fluxo, ou já usado (replay)
    return sendFrontendRedirect(res, 'state_invalido', 400, 'redirect_not_allowed');
  }
  if (!code || typeof code !== 'string') {
    return sendFrontendRedirect(res, 'erro', 400, 'redirect_not_allowed');
  }

  try {
    // Revalida o usuário do state — precisa continuar existindo e ativo.
    const { data: user } = await supabase
      .from('users')
      .select('id, ativo')
      .eq('id', ctx.userId)
      .maybeSingle();
    if (!user || user.ativo === false) {
      return sendFrontendRedirect(res, 'erro', 403, 'user_not_active');
    }

    const tokens = await trocarCodigoPorTokens(code);

    // Os tokens do Google NUNCA vão para o frontend — só para o banco,
    // sempre com o user_id do state (nunca de algo controlado pelo cliente).
    await supabase.from('google_tokens').upsert({
      user_id: ctx.userId,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    });

    return sendFrontendRedirect(res, 'conectado', 200, 'ok');
  } catch (err) {
    logger.error({ err }, 'Google OAuth callback failed');
    return sendFrontendRedirect(res, 'erro', 502, 'oauth_exchange_failed');
  }
});

// GET /auth/google/status — o frontend usa pra saber se mostra "Conectar" ou "conectado".
router.get('/status', requireAuth, async (req, res) => {
  const conectado = await estaConectado(req.user.id);
  res.json({ conectado });
});

export default router;
