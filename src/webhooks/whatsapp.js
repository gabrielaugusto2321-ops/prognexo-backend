import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { sendWhatsAppMessage } from '../lib/whatsapp.js';
import { processarMensagemComIA } from '../lib/iaAgent.js';
import { escolherCloserAutomatico } from '../lib/distribuicao.js';
import { buscarChunksRelevantes } from '../lib/knowledgeChunks.js';
import { verifyHmac } from '../lib/signatures.js';
import { claimWebhookEvent } from '../lib/salesWebhook.js';
import { CredentialVault } from '../lib/credentialVault.js';
import { webhookIdempotencyReady } from '../lib/readiness.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

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
  // Assinatura HMAC-SHA256 sobre o corpo BRUTO exatamente como a Meta enviou
  // (a Meta assina uma versão com unicode/barras escapados — por isso usamos
  // req.rawBody, nunca o JSON re-serializado). Ver docs/platform/WEBHOOKS.md.
  const signatureValid = verifyHmac({
    algorithm: 'sha256',
    secret: env.META_APP_SECRET,
    rawBody: req.rawBody,
    provided: req.get('X-Hub-Signature-256'),
    prefix: 'sha256=',
  });
  const enforce = env.NODE_ENV === 'production' || env.WHATSAPP_WEBHOOK_SIGNATURE_ENFORCED === 'true';
  if (enforce && !signatureValid) return res.sendStatus(403);
  if (!signatureValid) logger.warn('WhatsApp webhook signature not enforced in non-production');

  // Sem idempotência durável (webhook_events / migration 0005) não processamos
  // em produção — evita a IA responder duas vezes ao mesmo evento.
  if (env.NODE_ENV === 'production' && !(await webhookIdempotencyReady())) {
    logger.error('WhatsApp webhook received but idempotency store not ready');
    return res.sendStatus(503);
  }

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
      .select('id, doctor_id, organization_id, gateway, external_id, access_token, webhook_token, access_token_encrypted, webhook_token_encrypted')
      .eq('gateway', 'whatsapp')
      .eq('external_id', phoneNumberId)
      .maybeSingle();

    if (!integration) return; // número ainda não vinculado a nenhum médico

    // Token de envio resolvido pela mesma precedência dos outros 3 caminhos
    // de envio: token individual da integração (via mecanismo de
    // descriptografia existente) primeiro, fallback para META_SYSTEM_USER_TOKEN.
    let integrationAccessToken = null;
    try {
      const individualToken = CredentialVault.readIntegrationCredentialsFromRow(integration, ['access_token']).access_token;
      integrationAccessToken = CredentialVault.resolveEffectiveWhatsAppToken(individualToken);
    } catch (err) {
      logger.error({ err }, 'WhatsApp integration credential unreadable');
      return; // falha fechada — não tenta enviar sem token confiável
    }

    const { data: doctor } = await supabase
      .from('doctors')
      .select(
        'ia_atendimento_ativo, ia_contexto, ia_nome_agente, ia_palavras_proibidas, ia_score_minimo, ia_criterios, ia_limite_mensagens'
      )
      .eq('id', integration.doctor_id)
      .single();

    // Nome de perfil do WhatsApp de quem mandou a mensagem (se disponível),
    // usado só na hora de criar um lead novo automaticamente.
    const contactsPorTelefone = {};
    for (const c of value?.contacts || []) {
      contactsPorTelefone[c.wa_id] = c.profile?.name;
    }

    for (const msg of messages) {
      if (!msg.id) continue;
      const claimId = await claimWebhookEvent({ provider: 'whatsapp', externalEventId: msg.id, signatureValid, rawBody: req.rawBody });
      if (!claimId) continue;
      const telefoneNormalizado = msg.from?.replace(/\D/g, '');
      const conteudo = msg.text?.body ?? `[${msg.type}]`;

      let { data: lead } = await supabase
        .from('leads')
        .select('id, status_atual, atendido_por, ia_mensagens_enviadas, ia_sem_resposta_count')
        .eq('doctor_id', integration.doctor_id)
        .eq('telefone', telefoneNormalizado)
        .maybeSingle();

      // Número novo, ainda sem lead cadastrado — cria automaticamente em vez
      // de descartar a mensagem, pra nenhuma conversa recebida se perder.
      if (!lead) {
        const { data: novoLead } = await supabase
          .from('leads')
          .insert({
            doctor_id: integration.doctor_id,
            // tenant herdado da integração (resolução confiável do servidor)
            ...(integration.organization_id ? { organization_id: integration.organization_id } : {}),
            telefone: telefoneNormalizado,
            nome: contactsPorTelefone[msg.from] || telefoneNormalizado,
            status_atual: 'lead',
            journey_type: 'low_ticket',
          })
          .select('id, status_atual, atendido_por, ia_mensagens_enviadas, ia_sem_resposta_count')
          .single();

        if (!novoLead) continue;
        lead = novoLead;

        await supabase.from('deals').insert({ lead_id: lead.id, etapa: 'lead' });
      }

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

      // ---- Atendimento por IA ----
      // Só entra em ação se o médico tiver ativado, e se a conversa ainda
      // não tiver sido assumida por um closer humano (atendido_por='humano').
      const iaDeveResponder = doctor?.ia_atendimento_ativo && lead.atendido_por !== 'humano';
      if (!iaDeveResponder) continue;

      const { data: historico } = await supabase
        .from('conversations')
        .select('direcao, conteudo')
        .eq('lead_id', lead.id)
        .order('timestamp_msg', { ascending: true })
        .limit(30);

      // Contexto de produto: se esse lead já tem um negócio (deal) ligado a
      // um produto com contexto próprio de IA, usa ele além do contexto
      // geral do médico — permite abordagem diferente por especialidade.
      const { data: dealComProduto } = await supabase
        .from('deals')
        .select('products(ia_contexto)')
        .eq('lead_id', lead.id)
        .maybeSingle();

      // Base de conhecimento: embeda a última mensagem do lead e busca só
      // os trechos mais relevantes (busca vetorial), em vez de jogar todo
      // o texto ativo no prompt. Se a busca falhar, segue sem contexto
      // extra — não trava a resposta.
      let baseConhecimento = [];
      try {
        baseConhecimento = await buscarChunksRelevantes({
          doctorId: integration.doctor_id,
          pergunta: conteudo,
        });
      } catch (err) {
        logger.error({ err }, 'Knowledge search failed');
      }

      let resultado;
      try {
        resultado = await processarMensagemComIA({
          nomeAgente: doctor.ia_nome_agente,
          contextoDoMedico: doctor.ia_contexto,
          contextoDoProduto: dealComProduto?.products?.ia_contexto || null,
          baseConhecimento: baseConhecimento || [],
          palavrasProibidas: doctor.ia_palavras_proibidas,
          criterios: doctor.ia_criterios,
          scoreMinimo: doctor.ia_score_minimo,
          historico: historico || [],
        });
      } catch (err) {
        logger.error({ err }, 'WhatsApp AI failed');
        continue; // não trava o webhook — a conversa fica visível pro closer normalmente
      }

      // Trava de segurança: passou do limite de mensagens configurado sem
      // resolver (nem quente, nem frio)? Força handoff — evita loop infinito
      // com paciente ansioso, e evita custo de IA correndo solto.
      const mensagensJaEnviadas = (lead.ia_mensagens_enviadas || 0) + 1;
      const estourouLimite = mensagensJaEnviadas >= (doctor.ia_limite_mensagens || 20);
      if (resultado.status === 'qualificando' && estourouLimite) {
        resultado.status = 'quente';
        resultado.motivoHandoff = 'limite_mensagens';
      }

      // Extração passiva: só preenche campos que ainda estão vazios, nunca
      // sobrescreve um dado que o lead já tinha confirmado antes.
      const camposParaAtualizar = {
        ia_mensagens_enviadas: mensagensJaEnviadas,
        ...(resultado.semResposta ? { ia_sem_resposta_count: (lead.ia_sem_resposta_count || 0) + 1 } : {}),
        ...(resultado.score !== null ? { ia_score: resultado.score } : {}),
      };
      if (resultado.dados_extraidos) {
        const { data: leadAtual } = await supabase.from('leads').select('dados_extraidos').eq('id', lead.id).single();
        camposParaAtualizar.dados_extraidos = { ...(leadAtual?.dados_extraidos || {}), ...resultado.dados_extraidos };
      }
      await supabase.from('leads').update(camposParaAtualizar).eq('id', lead.id);

      // Proteção contra corrida: se um closer humano assumiu a conversa
      // enquanto a IA processava essa mensagem, não manda a resposta da IA
      // por cima — evita duas pessoas (bot e humano) respondendo juntas.
      const { data: leadAgora } = await supabase.from('leads').select('atendido_por').eq('id', lead.id).single();
      if (leadAgora?.atendido_por === 'humano') continue;

      // Pausa curta simulando digitação humana — proporcional ao tamanho
      // da resposta, com teto de 4s pra não atrasar demais quem está esperando.
      const pausaMs = Math.min(4000, 600 + resultado.resposta.length * 20);
      await new Promise((resolve) => setTimeout(resolve, pausaMs));

      const accessToken = integrationAccessToken;
      if (accessToken) {
        try {
          await sendWhatsAppMessage(integration.external_id, accessToken, telefoneNormalizado, resultado.resposta);
          await supabase.from('conversations').insert({
            lead_id: lead.id,
            canal: 'whatsapp',
            direcao: 'enviada',
            conteudo: resultado.resposta,
            origem: 'automatico',
            timestamp_msg: new Date().toISOString(),
          });
        } catch (err) {
          logger.error({ err }, 'WhatsApp response failed');
        }
      }

      // Handoff: lead quente vai pro closer com menos fila; lead frio ou
      // qualificado demais pra IA sozinha também sai do controle dela.
      if (resultado.status === 'quente') {
        const closerId = await escolherCloserAutomatico(integration.doctor_id);
        await supabase
          .from('leads')
          .update({
            atendido_por: 'humano',
            status_atual: 'reuniao_marcada',
            ia_motivo_handoff: resultado.motivoHandoff,
            ...(closerId ? { sdr_responsavel_id: closerId } : {}),
          })
          .eq('id', lead.id);
        await supabase.from('deals').update({ etapa: 'reuniao_marcada' }).eq('lead_id', lead.id);
      } else if (resultado.status === 'frio') {
        await supabase.from('leads').update({ atendido_por: 'humano' }).eq('id', lead.id);
      }
      // status 'qualificando' — não muda nada, IA continua na próxima mensagem
    }
  } catch (err) {
    logger.error({ err }, 'WhatsApp webhook processing failed');
  }
});

export default router;
