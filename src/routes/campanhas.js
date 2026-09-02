import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';
import { sendWhatsAppMessage } from '../lib/whatsapp.js';

const router = Router();
router.use(requireAuth);

async function checarAcesso(req, doctorId) {
  const scopedIds = await getScopedDoctorIds(req.user);
  return !scopedIds || scopedIds.includes(doctorId);
}

// GET /campanhas?doctor_id=
router.get('/', async (req, res) => {
  const { doctor_id } = req.query;
  if (!doctor_id) return res.status(400).json({ error: 'doctor_id necessário' });
  if (!(await checarAcesso(req, doctor_id))) return res.status(403).json({ error: 'Sem acesso a este médico' });

  const { data, error } = await supabase
    .from('campanhas')
    .select('*')
    .eq('doctor_id', doctor_id)
    .order('criado_em', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /campanhas  { doctor_id, nome, mensagem, filtro_status }
// Cria como rascunho — o disparo de verdade acontece em /campanhas/:id/enviar,
// separado, pra dar chance de revisar antes de sair mandando mensagem.
router.post('/', async (req, res) => {
  const { doctor_id, nome, mensagem, filtro_status } = req.body;
  if (!doctor_id || !nome?.trim() || !mensagem?.trim()) {
    return res.status(400).json({ error: 'doctor_id, nome e mensagem são obrigatórios' });
  }
  if (!(await checarAcesso(req, doctor_id))) return res.status(403).json({ error: 'Sem acesso a este médico' });

  let leadsQuery = supabase.from('leads').select('id', { count: 'exact' }).eq('doctor_id', doctor_id);
  if (filtro_status) leadsQuery = leadsQuery.eq('status_atual', filtro_status);
  const { count } = await leadsQuery;

  const { data, error } = await supabase
    .from('campanhas')
    .insert({
      doctor_id,
      nome: nome.trim(),
      mensagem: mensagem.trim(),
      filtro_status: filtro_status || null,
      total_leads: count || 0,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /campanhas/:id/enviar
// Dispara pra quem está dentro da janela de 24h (mensagem livre, sem custo
// extra); quem está fora fica marcado como pendente_template — a Meta exige
// template aprovado pra reabrir conversa fora da janela, e isso ainda
// depende da verificação de negócio ser concluída.
router.post('/:id/enviar', async (req, res) => {
  const { data: campanha } = await supabase.from('campanhas').select('*').eq('id', req.params.id).single();
  if (!campanha) return res.status(404).json({ error: 'Campanha não encontrada' });
  if (!(await checarAcesso(req, campanha.doctor_id))) return res.status(403).json({ error: 'Sem acesso' });
  if (campanha.status !== 'rascunho') return res.status(409).json({ error: 'Campanha já foi enviada' });

  const { data: integration } = await supabase
    .from('integrations')
    .select('external_id, access_token')
    .eq('doctor_id', campanha.doctor_id)
    .eq('gateway', 'whatsapp')
    .maybeSingle();

  const accessToken = integration?.access_token || process.env.META_SYSTEM_USER_TOKEN;
  if (!integration?.external_id || !accessToken) {
    return res.status(400).json({ error: 'WhatsApp não configurado para este médico' });
  }

  let leadsQuery = supabase.from('leads').select('id, nome, telefone').eq('doctor_id', campanha.doctor_id);
  if (campanha.filtro_status) leadsQuery = leadsQuery.eq('status_atual', campanha.filtro_status);
  const { data: leads } = await leadsQuery;

  let enviados = 0;
  let pendentesTemplate = 0;

  for (const lead of leads || []) {
    const { data: ultimaRecebida } = await supabase
      .from('conversations')
      .select('timestamp_msg')
      .eq('lead_id', lead.id)
      .eq('direcao', 'recebida')
      .order('timestamp_msg', { ascending: false })
      .limit(1)
      .maybeSingle();

    const dentroDaJanela =
      ultimaRecebida && Date.now() - new Date(ultimaRecebida.timestamp_msg).getTime() < 24 * 60 * 60 * 1000;

    if (!dentroDaJanela) {
      pendentesTemplate++;
      continue;
    }

    try {
      await sendWhatsAppMessage(integration.external_id, accessToken, lead.telefone, campanha.mensagem);
      await supabase.from('conversations').insert({
        lead_id: lead.id,
        canal: 'whatsapp',
        direcao: 'enviada',
        conteudo: campanha.mensagem,
        origem: 'manual',
        timestamp_msg: new Date().toISOString(),
      });
      enviados++;
    } catch (err) {
      console.error(`Erro ao enviar campanha pro lead ${lead.id}:`, err.message);
    }
  }

  const { data: atualizada, error } = await supabase
    .from('campanhas')
    .update({
      status: 'concluida',
      enviados,
      pendentes_template: pendentesTemplate,
      enviado_em: new Date().toISOString(),
    })
    .eq('id', campanha.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(atualizada);
});

export default router;
