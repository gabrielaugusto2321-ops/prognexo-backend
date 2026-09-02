import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /doctors — lista os médicos que o usuário logado pode ver
router.get('/', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);

  let query = supabase.from('doctors').select('*').order('criado_em', { ascending: false });
  if (scopedIds) query = query.in('id', scopedIds);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /doctors — só admin cria médico novo
router.post('/', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Só admin pode cadastrar médicos' });
  }

  const { data, error } = await supabase.from('doctors').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /doctors/:id/ia — liga/desliga o atendimento por IA e salva
// contexto, nome do agente, guardrails e critérios de qualificação
router.patch('/:id/ia', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  if (scopedIds && !scopedIds.includes(req.params.id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const { ia_atendimento_ativo, ia_contexto, ia_nome_agente, ia_palavras_proibidas, ia_score_minimo, ia_criterios, ia_limite_mensagens } = req.body;
  const campos = {};
  if (ia_atendimento_ativo !== undefined) campos.ia_atendimento_ativo = ia_atendimento_ativo;
  if (ia_contexto !== undefined) campos.ia_contexto = ia_contexto;
  if (ia_nome_agente !== undefined) campos.ia_nome_agente = ia_nome_agente;
  if (ia_palavras_proibidas !== undefined) campos.ia_palavras_proibidas = ia_palavras_proibidas;
  if (ia_score_minimo !== undefined) campos.ia_score_minimo = ia_score_minimo;
  if (ia_criterios !== undefined) campos.ia_criterios = ia_criterios;
  if (ia_limite_mensagens !== undefined) campos.ia_limite_mensagens = ia_limite_mensagens;

  const { data, error } = await supabase
    .from('doctors')
    .update(campos)
    .eq('id', req.params.id)
    .select('id, ia_atendimento_ativo, ia_contexto, ia_nome_agente, ia_palavras_proibidas, ia_score_minimo, ia_criterios, ia_limite_mensagens')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /doctors/:id/ia/gerar-contexto
// Onboarding rápido: o médico descreve o negócio em 2-3 frases, e a IA
// devolve um contexto completo pronto pra revisar e salvar — sem exigir
// que ele escreva o texto de configuração do zero.
router.post('/:id/ia/gerar-contexto', async (req, res) => {
  const scopedIds = await getScopedDoctorIds(req.user);
  if (scopedIds && !scopedIds.includes(req.params.id)) {
    return res.status(403).json({ error: 'Sem acesso a este médico' });
  }

  const { descricao } = req.body;
  if (!descricao || descricao.trim().length < 5) {
    return res.status(400).json({ error: 'Descrição do negócio é obrigatória' });
  }

  const prompt = `Um médico descreveu o próprio negócio assim: "${descricao}"

Baseado nisso, escreva um "contexto de IA" pronto pra ser colado direto na configuração de um agente de qualificação de leads por WhatsApp. O texto deve:
- Explicar o que é vendido/oferecido (produto, serviço, ticket se mencionado)
- Sugerir o tom de voz adequado
- Sugerir o que caracteriza um lead "quente" nesse contexto

Escreva em português, direto, entre 3 e 6 frases — sem markdown, sem título, só o parágrafo de contexto pronto pra uso. Responda só com o texto do contexto, nada além disso.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || 'Erro ao gerar contexto');
    const contextoGerado = data?.content?.[0]?.text?.trim() || '';
    res.json({ ia_contexto: contextoGerado });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
