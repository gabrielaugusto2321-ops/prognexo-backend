import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { configuredTeamInviteEmailAdapter } from '../lib/emailAdapter.js';
import { processOutboxBatch } from '../lib/teamInviteOutbox.js';
import { processCampaignJobs } from '../jobs/campaignSendHandler.js';
import { requireJobRunnerAuth } from '../lib/jobRunnerAuth.js';

const router = Router();

// FASE 2.8 — worker HTTP da fila de jobs de campanha. Autenticação SÓ por
// header (Authorization: Bearer <JOB_RUNNER_SECRET> ou X-Prognexo-Job-Token),
// timing-safe, NUNCA por query string. Disparado por um cron/scheduler
// externo único. O claim com SKIP LOCKED garante que dois disparos
// concorrentes nunca processam o mesmo job.
router.post('/campaign-outbox', requireJobRunnerAuth, async (req, res) => {
  if (env.PERSISTENT_JOB_QUEUE_ENABLED !== 'true' || env.CAMPAIGN_JOB_QUEUE_ENABLED !== 'true') {
    return res.status(404).json({ error: 'not_found' });
  }
  const summary = await processCampaignJobs({ workerId: `campaign-http-${process.pid}-${Date.now()}`, batchSize: 20, log: req.log });
  return res.json(summary);
});

router.post('/team-invite-outbox', async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Token inválido' });
  if (env.TEAM_INVITE_OUTBOX_ENABLED !== 'true') return res.status(404).json({ error: 'not_found' });
  if ((env.APP_ENV === 'production' || env.APP_ENV === 'staging') && env.TEAM_INVITE_EMAIL_DELIVERY_ENABLED !== 'true') {
    return res.status(503).json({ error: 'email_delivery_disabled' });
  }
  // Best-effort: marca convites 'queued'/'sent' vencidos como 'expired' antes
  // de processar o outbox. Nunca bloqueia o processamento se falhar (a
  // garantia de segurança real — convite expirado não é aceito — já vive em
  // team_invitation_accept, independente desta varredura).
  const swept = await supabase.rpc('team_invitation_sweep_expired').catch((err) => { req.log?.error({ err }, 'invitation expiry sweep failed'); return { data: null }; });
  const summary = await processOutboxBatch({
    workerId: `http-${process.pid}-${Date.now()}`,
    batchSize: 20,
    adapter: configuredTeamInviteEmailAdapter(),
  });
  return res.json({ ...summary, expired: swept.data ?? null });
});

// POST /jobs/limpar-leads-esquecidos?secret=TOKEN
// NÃO exige login — é chamada por um serviço externo de cron (cron-job.org,
// grátis), não por uma pessoa logada. A segurança vem do secret na URL.
//
// Regra: lead parado em "lead" ou "conversa_iniciada" há mais de 7 dias
// sem nenhuma mensagem nova vira "perdido" sozinho — evita funil lotado
// de lead fantasma que ninguém vai mais responder.
router.post('/limpar-leads-esquecidos', async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const seteDiasAtras = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  // Busca candidatos: ainda em etapa aberta, criados há mais de 7 dias
  const { data: candidatos, error } = await supabase
    .from('leads')
    .select('id, criado_em')
    .in('status_atual', ['lead', 'conversa_iniciada'])
    .lt('criado_em', seteDiasAtras);

  if (error) { req.log?.error({ err: error }, 'Database request failed'); return res.status(500).json({ error: 'internal_error', requestId: req.id }); }
  if (!candidatos || candidatos.length === 0) {
    return res.json({ marcados_como_perdido: 0 });
  }

  const candidatoIds = candidatos.map((c) => c.id);

  // Confirma que também não teve mensagem recente (só criado_em não basta,
  // o lead pode ter respondido depois de muito tempo)
  const { data: conversasRecentes } = await supabase
    .from('conversations')
    .select('lead_id')
    .in('lead_id', candidatoIds)
    .gte('timestamp_msg', seteDiasAtras);

  const idsComConversaRecente = new Set((conversasRecentes || []).map((c) => c.lead_id));
  const idsParaMarcar = candidatoIds.filter((id) => !idsComConversaRecente.has(id));

  if (idsParaMarcar.length === 0) {
    return res.json({ marcados_como_perdido: 0 });
  }

  await supabase.from('leads').update({ status_atual: 'perdido' }).in('id', idsParaMarcar);
  await supabase.from('deals').update({ etapa: 'perdido', motivo_perda: 'Sem resposta há mais de 7 dias' }).in('lead_id', idsParaMarcar);

  res.json({ marcados_como_perdido: idsParaMarcar.length });
});

export default router;
