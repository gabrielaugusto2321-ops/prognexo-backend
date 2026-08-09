import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// GET /webhooks/whatsapp — verificação exigida pela Meta ao registrar o webhook
// A Meta chama essa rota uma vez, na hora de "Verify and Save" no App Dashboard.
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST /webhooks/whatsapp — eventos reais (mensagens recebidas, status de envio)
// Formato oficial da Meta Cloud API:
// https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/
router.post('/', async (req, res) => {
  // Responde 200 imediatamente — a Meta espera resposta rápida e reenvia se não receber
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Notificação de status (entregue/lido) — por ora só ignoramos, não é conversa nova
    if (value?.statuses) return;

    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    for (const msg of messages) {
      const telefoneNormalizado = msg.from?.replace(/\D/g, '');
      const conteudo = msg.text?.body ?? `[${msg.type}]`; // mídia/áudio/etc ainda sem parsing de conteúdo

      const { data: lead } = await supabase
        .from('leads')
        .select('id, status_atual')
        .eq('telefone', telefoneNormalizado)
        .maybeSingle();

      if (!lead) continue; // mensagem de número sem lead associado — ignora por ora

      await supabase.from('conversations').insert({
        lead_id: lead.id,
        canal: 'whatsapp',
        direcao: 'recebida',
        conteudo,
        origem: 'automatico',
        timestamp_msg: new Date(Number(msg.timestamp) * 1000).toISOString(),
      });

      // Primeira mensagem do lead → avança lead e deal pra "conversa_iniciada"
      if (lead.status_atual === 'lead') {
        await supabase.from('leads').update({ status_atual: 'conversa_iniciada' }).eq('id', lead.id);
        await supabase.from('deals').update({ etapa: 'conversa_iniciada' }).eq('lead_id', lead.id);
      }
    }
  } catch (err) {
    // Erros aqui não devem afetar a resposta já enviada à Meta — só logamos
    console.error('Erro processando webhook WhatsApp:', err);
  }
});

export default router;
