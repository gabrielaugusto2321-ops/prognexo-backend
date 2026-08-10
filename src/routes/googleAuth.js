import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { buildAuthUrl, trocarCodigoPorTokens, estaConectado } from '../lib/googleCalendar.js';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://prognexo-frontend.vercel.app';

// GET /auth/google/connect — devolve a URL pra onde o navegador deve ir
router.get('/connect', requireAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({ user_id: req.user.id })).toString('base64');
  res.json({ url: buildAuthUrl(state) });
});

// GET /auth/google/callback — o Google chama essa rota depois que a pessoa autoriza.
// NÃO exige login (o navegador chega aqui direto do Google, sem nosso token) —
// identificamos quem é através do "state" que a gente mesmo mandou no passo anterior.
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { user_id } = JSON.parse(Buffer.from(state, 'base64').toString());

    const tokens = await trocarCodigoPorTokens(code);

    await supabase.from('google_tokens').upsert({
      user_id,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    });

    res.redirect(`${FRONTEND_URL}/#/agenda?google=conectado`);
  } catch (err) {
    console.error('Erro no callback do Google:', err);
    res.redirect(`${FRONTEND_URL}/#/agenda?google=erro`);
  }
});

// GET /auth/google/status — o frontend usa isso pra saber se já mostra
// o botão "Conectar" ou o selinho de "já conectado"
router.get('/status', requireAuth, async (req, res) => {
  const conectado = await estaConectado(req.user.id);
  res.json({ conectado });
});

export default router;
