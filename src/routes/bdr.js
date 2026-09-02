import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, getScopedDoctorIds } from '../middleware/auth.js';
import { gerarVariacoesProspeccao } from '../lib/bdrAgent.js';

// Agente BDR: prospecção ativa sob demanda. 1 agente por médico.
// Não roda no webhook, não qualifica lead — só o CRUD do agente e um
// endpoint que redige mensagens quando a equipe pede.

const router = Router();
router.use(requireAuth);

async function checarAcesso(req, doctorId) {
  const scopedIds = await getScopedDoctorIds(req.user);
  return !scopedIds || scopedIds.includes(doctorId);
}

// GET /bdr?doctor_id=  — o agente BDR do médico (ou null se não tiver)
router.get('/', async (req, res) => {
  const { doctor_id } = req.query;
  if (!doctor_id) return res.status(400).json({ error: 'doctor_id necessário' });
  if (!(await checarAcesso(req, doctor_id))) return res.status(403).json({ error: 'Sem acesso a este médico' });

  const { data, error } = await supabase
    .from('ia_agentes_bdr')
    .select('*')
    .eq('doctor_id', doctor_id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /bdr  { doctor_id, nome?, contexto? }
// Upsert: como é 1 por médico, reenviar cria ou substitui o agente.
router.post('/', async (req, res) => {
  const { doctor_id, nome, contexto } = req.body;
  if (!doctor_id) return res.status(400).json({ error: 'doctor_id é obrigatório' });
  if (!(await checarAcesso(req, doctor_id))) return res.status(403).json({ error: 'Sem acesso a este médico' });

  const { data, error } = await supabase
    .from('ia_agentes_bdr')
    .upsert(
      { doctor_id, nome: nome?.trim() || 'BDR', contexto: contexto?.trim() || null },
      { onConflict: 'doctor_id' }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /bdr/:id  { nome?, contexto?, ativo? }
router.patch('/:id', async (req, res) => {
  const { data: item } = await supabase.from('ia_agentes_bdr').select('doctor_id').eq('id', req.params.id).single();
  if (!item) return res.status(404).json({ error: 'Não encontrado' });
  if (!(await checarAcesso(req, item.doctor_id))) return res.status(403).json({ error: 'Sem acesso' });

  const { nome, contexto, ativo } = req.body;
  const campos = {};
  if (nome !== undefined) campos.nome = nome;
  if (contexto !== undefined) campos.contexto = contexto;
  if (ativo !== undefined) campos.ativo = ativo;

  const { data, error } = await supabase.from('ia_agentes_bdr').update(campos).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /bdr/:id
router.delete('/:id', async (req, res) => {
  const { data: item } = await supabase.from('ia_agentes_bdr').select('doctor_id').eq('id', req.params.id).single();
  if (!item) return res.status(404).json({ error: 'Não encontrado' });
  if (!(await checarAcesso(req, item.doctor_id))) return res.status(403).json({ error: 'Sem acesso' });

  const { error } = await supabase.from('ia_agentes_bdr').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// POST /bdr/:id/gerar-mensagem  { objetivo }
// Redige 3 variações de uma mensagem de prospecção a partir de um
// objetivo em texto livre. Nada é persistido, não toca em lead/deal.
router.post('/:id/gerar-mensagem', async (req, res) => {
  const { data: agente } = await supabase
    .from('ia_agentes_bdr')
    .select('doctor_id, nome, contexto, ativo')
    .eq('id', req.params.id)
    .single();
  if (!agente) return res.status(404).json({ error: 'Agente BDR não encontrado' });
  if (!(await checarAcesso(req, agente.doctor_id))) return res.status(403).json({ error: 'Sem acesso' });
  if (!agente.ativo) return res.status(409).json({ error: 'Agente BDR está desativado' });

  const { objetivo } = req.body;
  if (!objetivo?.trim()) return res.status(400).json({ error: 'objetivo é obrigatório' });

  try {
    const variacoes = await gerarVariacoesProspeccao({
      nomeAgente: agente.nome,
      contexto: agente.contexto,
      objetivo,
    });
    res.json({ variacoes });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
