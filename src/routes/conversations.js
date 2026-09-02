import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds, isScopedToOwnLeadsOnly } from '../middleware/auth.js';
import { sendWhatsAppMessage } from '../lib/whatsapp.js';

const router = Router();
router.use(requireAuth);

function formatarHora(timestamp) {
  if (!timestamp) return '';
  const data = new Date(timestamp);
  const hoje = new Date();
  const ontem = new Date(hoje);
  ontem.setDate(hoje.getDate() - 1);

  const mesmoDia = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const hora = data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  if (mesmoDia(data, hoje)) return `Hoje, ${hora}`;
  if (mesmoDia(data, ontem)) return `Ontem, ${hora}`;
  return `${data.toLocaleDateString('pt-BR')}, ${hora}`;
}

function iniciais(nome) {
  if (!nome) return '';
  return nome.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
}

// GET /conversations?doctor_id=&lead_id=
// Timeline de mensagens (hoje só WhatsApp), agrupada por lead — mais recente primeiro.
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  const { doctor_id, lead_id } = req.query;

  let query = supabase
    .from('conversations')
    .select(
      '*, leads!inner(id, nome, doctor_id, sdr_responsavel_id, atendido_por, ia_score, doctors(nome), deals(products(nome)), sdr:users!leads_sdr_responsavel_id_fkey(nome))'
    )
    .order('timestamp_msg', { ascending: false })
    .limit(300);

  if (lead_id) query = query.eq('lead_id', lead_id);
  if (doctor_id) query = query.eq('leads.doctor_id', doctor_id);
  else if (scopedIds) query = query.in('leads.doctor_id', scopedIds);

  // Closer só vê conversas dos próprios leads
  if (isScopedToOwnLeadsOnly(req.user)) {
    query = query.eq('leads.sdr_responsavel_id', req.user.id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Agrupa as linhas por lead, na ordem em que o lead mais recente apareceu primeiro
  const gruposPorLead = new Map();
  for (const row of data) {
    const lead = row.leads;
    if (!gruposPorLead.has(lead.id)) {
      gruposPorLead.set(lead.id, {
        lead_id: lead.id,
        lead: lead.nome,
        doctor: lead.doctors?.nome ?? '',
        produto: lead.deals?.[0]?.products?.nome ?? '',
        atendido_por: lead.atendido_por || null,
        ia_score: lead.ia_score ?? null,
        mensagens: [],
      });
    }
    gruposPorLead.get(lead.id).mensagens.push({
      id: row.id,
      direcao: row.direcao,
      texto: row.conteudo,
      origem: row.origem,
      sdr: row.origem === 'manual' ? iniciais(lead.sdr?.nome) : undefined,
      hora: formatarHora(row.timestamp_msg),
      timestamp_msg: row.timestamp_msg,
    });
  }

  // Mensagens dentro de cada grupo em ordem cronológica (mais antiga primeiro)
  const grupos = Array.from(gruposPorLead.values()).map((g) => ({
    ...g,
    mensagens: g.mensagens.slice().reverse(),
  }));

  res.json(grupos);
});

// POST /conversations/send  { lead_id, texto }
// Envia mensagem de verdade pelo WhatsApp Cloud API (fica igual Kommo: closer
// responde de dentro do CRM, não precisa mais abrir o celular).
router.post('/send', async (req, res) => {
  const { lead_id, texto } = req.body;
  if (!lead_id || !texto?.trim()) {
    return res.status(400).json({ error: 'lead_id e texto são obrigatórios' });
  }

  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('id, telefone, doctor_id, sdr_responsavel_id')
    .eq('id', lead_id)
    .single();

  if (leadError || !lead) return res.status(404).json({ error: 'Lead não encontrado' });

  // Closer só pode responder os próprios leads
  if (isScopedToOwnLeadsOnly(req.user) && lead.sdr_responsavel_id !== req.user.id) {
    return res.status(403).json({ error: 'Sem acesso a este lead' });
  }

  const { data: integration } = await supabase
    .from('integrations')
    .select('external_id, access_token')
    .eq('doctor_id', lead.doctor_id)
    .eq('gateway', 'whatsapp')
    .maybeSingle();

  if (!integration?.external_id) {
    return res.status(400).json({ error: 'WhatsApp não configurado para este médico' });
  }

  // Token de envio: se o médico conectou manualmente (token colado em
  // Integrações), usa esse. Se conectou pelo Embedded Signup, não existe
  // token próprio — usa o token fixo do usuário de sistema, que já tem
  // permissão sobre a WABA dele (compartilhada automaticamente no fluxo).
  const accessToken = integration.access_token || process.env.META_SYSTEM_USER_TOKEN;
  if (!accessToken) {
    return res.status(400).json({ error: 'Nenhum token de envio disponível para este médico' });
  }

  // Janela de 24h: só permite texto livre se a última mensagem RECEBIDA
  // (do lead) foi há menos de 24h. Fora disso, a Meta exige template aprovado.
  const { data: ultimaRecebida } = await supabase
    .from('conversations')
    .select('timestamp_msg')
    .eq('lead_id', lead_id)
    .eq('direcao', 'recebida')
    .order('timestamp_msg', { ascending: false })
    .limit(1)
    .maybeSingle();

  const dentroDaJanela =
    ultimaRecebida &&
    Date.now() - new Date(ultimaRecebida.timestamp_msg).getTime() < 24 * 60 * 60 * 1000;

  if (!dentroDaJanela) {
    return res.status(409).json({
      error: 'janela_expirada',
      message:
        'Passou mais de 24h desde a última mensagem do lead. É necessário um template aprovado pela Meta para reabrir a conversa.',
    });
  }

  try {
    await sendWhatsAppMessage(integration.external_id, accessToken, lead.telefone, texto.trim());
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const { data: novaMensagem, error: insertError } = await supabase
    .from('conversations')
    .insert({
      lead_id,
      canal: 'whatsapp',
      direcao: 'enviada',
      conteudo: texto.trim(),
      origem: 'manual',
      timestamp_msg: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) return res.status(500).json({ error: insertError.message });

  res.json(novaMensagem);
});

export default router;
