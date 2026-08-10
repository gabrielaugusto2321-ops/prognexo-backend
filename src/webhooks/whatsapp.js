import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

// GET /webhooks/whatsapp — verificação exigida pela Meta ao registrar o webhook
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST /webhooks/whatsapp — eventos reais (mensagens recebidas)
// Um único webhook serve TODOS os médicos: a Meta manda o "phone_number_id"
// de qual número recebeu a mensagem, e usamos isso pra saber de qual médico é.
// Cada médico cadastra o próprio phone_number_id na tela "Integrações".
router.post('/', async (req, res) => {
  res.sendStatus(200); // responde rápido, processa depois

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (value?.statuses) return; // status de entrega/leitura — ignora por ora

    const phoneNumberId = value?.metadata?.phone_number_id;
    const messages = value?.messages;
    if (!messages || messages.length === 0 || !phoneNumberId) return;

    // Descobre de qual médico é esse número
    const { data: integration } = await supabase
      .from('integrations')
      .select('doctor_id')
      .eq('gateway', 'whatsapp')
      .eq('external_id', phoneNumberId)
      .maybeSingle();

    if (!integration) return; // número ainda não vinculado a nenhum médico

    for (const msg of messages) {
      const telefoneNormalizado = msg.from?.replace(/\D/g, '');
      const conteudo = msg.text?.body ?? `[${msg.type}]`;

      const { data: lead } = await supabase
        .from('leads')
        .select('id, status_atual')
        .eq('doctor_id', integration.doctor_id)
        .eq('telefone', telefoneNormalizado)
        .maybeSingle();

      if (!lead) continue;

      await supabase.from('conversations').insert({
        lead_id: lead.id,
        canal: 'whatsapp',
        direcao: 'recebida',
        conteudo,
        origem: 'automatico',
        timestamp_msg: new Date(Number(msg.timestamp) * 1000).toISOString(),
      });

      if (lead.status_atual === 'lead') {
        await supabase.from('leads').update({ status_atual: 'conversa_iniciada' }).eq('id', lead.id);
        await supabase.from('deals').update({ etapa: 'conversa_iniciada' }).eq('lead_id', lead.id);
      }
    }
  } catch (err) {
    console.error('Erro processando webhook WhatsApp:', err);
  }
});

export default router;
