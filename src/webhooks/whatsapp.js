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
import { normalizeBrazilianPhone, resolveCanonicalSendPhone, isPhoneIdentityReviewRequired } from '../lib/phoneNormalization.js';
import { resolveQuarantineLead } from '../lib/phoneIdentityQuarantine.js';

const LEAD_IDENTITY_SELECT = 'id, status_atual, atendido_por, ia_mensagens_enviadas, ia_sem_resposta_count, telefone, telefone_normalizado, whatsapp_wa_id, dados_extraidos';

const router = Router();

const OPT_OUT_WORDS = new Set(['PARAR', 'SAIR', 'STOP', 'CANCELAR']);
export function isWhatsAppOptOut(text) {
  const normalized = String(text ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return OPT_OUT_WORDS.has(normalized);
}

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

    for (const [msgIndex, msg] of messages.entries()) {
      if (!msg.id) continue;
      const claimId = await claimWebhookEvent({ provider: 'whatsapp', externalEventId: msg.id, signatureValid, rawBody: req.rawBody });
      if (!claimId) continue;

      // Identidade do remetente: preferimos o wa_id do objeto `contacts`
      // (correspondência posicional com `messages`, conforme o formato do
      // webhook da Meta) e caímos para `from` só se não houver contato
      // correspondente. Ambos são normalizados para dígitos apenas — nenhuma
      // lógica de nono dígito acontece aqui, só em normalizeBrazilianPhone.
      const waIdBruto = (value?.contacts?.[msgIndex]?.wa_id ?? msg.from ?? '').replace(/\D/g, '');
      const fromBruto = (msg.from ?? '').replace(/\D/g, '');
      const rawDigits = waIdBruto || fromBruto;
      const identidade = normalizeBrazilianPhone(rawDigits);
      const canonical = identidade.valid ? identidade.canonical : null;
      const conteudo = msg.text?.body ?? `[${msg.type}]`;

      // 1) Correspondência exata por whatsapp_wa_id — já vinculado antes,
      //    nunca ambígua (índice único parcial por doctor_id+wa_id).
      let lead = null;
      if (rawDigits) {
        const { data } = await supabase.from('leads').select(LEAD_IDENTITY_SELECT)
          .eq('doctor_id', integration.doctor_id).eq('whatsapp_wa_id', rawDigits).maybeSingle();
        lead = data;
      }

      // 2) Telefone canônico (E.164) já resolvido para este médico.
      if (!lead && canonical) {
        const { data } = await supabase.from('leads').select(LEAD_IDENTITY_SELECT)
          .eq('doctor_id', integration.doctor_id).eq('telefone_normalizado', canonical).maybeSingle();
        lead = data;
      }

      // 3) Formatos legados equivalentes do MESMO médico (telefone bruto
      //    gravado antes desta identidade existir). Nunca cruza doctor_id.
      //    Mais de um candidato aqui é ambiguidade real — não escolhemos por
      //    conta própria, registramos e pulamos a mensagem.
      let ambiguo = false;
      if (!lead) {
        const candidatosLegado = new Set([rawDigits, fromBruto].filter(Boolean));
        if (identidade.valid) candidatosLegado.add(identidade.national);
        if (candidatosLegado.size > 0) {
          const { data: legados } = await supabase.from('leads').select(LEAD_IDENTITY_SELECT)
            .eq('doctor_id', integration.doctor_id).in('telefone', [...candidatosLegado]);
          const distintos = legados || [];
          if (distintos.length === 1) lead = distintos[0];
          else if (distintos.length > 1) ambiguo = true;
        }
      }

      if (ambiguo) {
        // Log sanitizado: nunca o telefone completo, nunca a lista de
        // candidatos — só médico + últimos 4 dígitos, o suficiente para
        // revisão manual sem vazar PII.
        logger.error(
          { doctorId: integration.doctor_id, last4: rawDigits.slice(-4) },
          'WhatsApp inbound: identidade de telefone ambígua — lead de quarentena usado, nunca unida automaticamente'
        );

        // NUNCA descarta a mensagem: cria ou reutiliza um lead de quarentena
        // pela mesma chave exata (doctor_id + whatsapp_wa_id) que a busca 1)
        // já usa. A função trata a corrida entre duas mensagens concorrentes
        // do mesmo wa_id (índice único parcial da migration 0016) sem nunca
        // virar erro 500 nem duplicar o lead.
        let quarentena;
        let quarentenaCriadaAgora = false;
        try {
          const resolvido = await resolveQuarantineLead({
            supabase,
            doctorId: integration.doctor_id,
            organizationId: integration.organization_id,
            rawDigits,
            telefoneOriginal: msg.from || rawDigits,
            nome: contactsPorTelefone[msg.from] || rawDigits,
            select: LEAD_IDENTITY_SELECT,
          });
          quarentena = resolvido.lead;
          quarentenaCriadaAgora = resolvido.created;
        } catch (err) {
          // Falha explícita e sanitizada — nunca o telefone, nunca a
          // mensagem de erro do banco (pode conter a chave no DETAIL), só o
          // código. O webhook_events desta mensagem fica 'processing'
          // (preservado) para o mecanismo idempotente existente; a IA nunca
          // é chamada para esta mensagem.
          logger.error(
            { doctorId: integration.doctor_id, last4: rawDigits.slice(-4), code: err?.code || 'quarantine_lead_failed' },
            'WhatsApp inbound: falha ao resolver lead de quarentena — mensagem preservada para retry, IA não chamada'
          );
          continue;
        }

        lead = quarentena;

        // O deal só é criado na primeira vez (lead novo) — uma mensagem
        // posterior do mesmo wa_id (reutilizando o mesmo lead de quarentena,
        // seja por já existir, seja por ter perdido a corrida concorrente)
        // nunca duplica o deal.
        if (quarentenaCriadaAgora) {
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
        continue; // conversa gravada; IA nunca responde a um lead em quarentena
      }

      // Número novo, ainda sem lead cadastrado — cria automaticamente em vez
      // de descartar a mensagem, pra nenhuma conversa recebida se perder.
      // Telefone original é preservado como veio; whatsapp_wa_id guarda o
      // identificador bruto da Meta; telefone_normalizado só é gravado
      // quando a conversão é determinística (nunca um valor ambíguo/parcial).
      if (!lead) {
        const { data: novoLead } = await supabase
          .from('leads')
          .insert({
            doctor_id: integration.doctor_id,
            // tenant herdado da integração (resolução confiável do servidor)
            ...(integration.organization_id ? { organization_id: integration.organization_id } : {}),
            telefone: msg.from || rawDigits,
            whatsapp_wa_id: rawDigits || null,
            ...(canonical ? { telefone_normalizado: canonical } : {}),
            nome: contactsPorTelefone[msg.from] || rawDigits,
            status_atual: 'lead',
            journey_type: 'low_ticket',
          })
          .select(LEAD_IDENTITY_SELECT)
          .single();

        if (!novoLead) continue;
        lead = novoLead;

        await supabase.from('deals').insert({ lead_id: lead.id, etapa: 'lead' });
      } else {
        // Lead reaproveitado (achado por wa_id, canônico ou legado): só
        // preenche o que ainda está vazio — nunca sobrescreve um valor já
        // gravado, e nunca substitui uma identidade diferente da que já tem.
        const patch = {};
        if (!lead.whatsapp_wa_id && rawDigits) patch.whatsapp_wa_id = rawDigits;
        if (!lead.telefone_normalizado && canonical) patch.telefone_normalizado = canonical;
        if (Object.keys(patch).length > 0) {
          await supabase.from('leads').update(patch).eq('id', lead.id);
          lead = { ...lead, ...patch };
        }
      }

      await supabase.from('conversations').insert({
        lead_id: lead.id,
        canal: 'whatsapp',
        direcao: 'recebida',
        conteudo,
        origem: 'automatico',
        timestamp_msg: new Date(Number(msg.timestamp) * 1000).toISOString(),
      });

      if (msg.type === 'text' && isWhatsAppOptOut(msg.text?.body)) {
        await supabase.from('leads').update({
          whatsapp_authorization_status: 'opt_out',
          whatsapp_authorization_at: new Date().toISOString(),
          whatsapp_authorization_source: 'whatsapp_message',
        }).eq('id', lead.id);
        continue;
      }

      if (lead.status_atual === 'lead') {
        await supabase.from('leads').update({ status_atual: 'conversa_iniciada' }).eq('id', lead.id);
        await supabase.from('deals').update({ etapa: 'conversa_iniciada' }).eq('lead_id', lead.id);
      }

      // ---- Atendimento por IA ----
      // Recarrega o status de autorização mais recente antes de decidir —
      // pode ter mudado (opt-out) entre a resolução do lead e este ponto, ou
      // numa mensagem anterior deste mesmo lote (correção 2 da FASE 1: o
      // bloqueio de IA precisa ser durável para o lead, não só para a
      // mensagem de opt-out em si). A conversa recebida já foi gravada acima
      // — continua visível para atendimento humano mesmo quando a IA é
      // bloqueada aqui; só a resposta AUTOMÁTICA é interrompida.
      const { data: leadAtual } = await supabase
        .from('leads')
        .select('whatsapp_authorization_status, dados_extraidos')
        .eq('id', lead.id)
        .maybeSingle();
      const statusAutorizacao = leadAtual?.whatsapp_authorization_status ?? 'pendente';
      const bloqueadoPorConsentimento = statusAutorizacao === 'opt_out' || statusAutorizacao === 'recusado';
      // Lead em quarentena de identidade (telefone ambíguo) nunca recebe
      // resposta automática — nenhum envio à Meta até revisão humana.
      const bloqueadoPorIdentidade = isPhoneIdentityReviewRequired(leadAtual);

      // Só entra em ação se o médico tiver ativado, a conversa ainda não
      // tiver sido assumida por um closer humano (atendido_por='humano'), o
      // lead não estiver com consentimento recusado/opt_out, e a identidade
      // do telefone não estiver em revisão.
      const iaDeveResponder = !bloqueadoPorConsentimento && !bloqueadoPorIdentidade && doctor?.ia_atendimento_ativo && lead.atendido_por !== 'humano';
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
      const destino = resolveCanonicalSendPhone(lead);
      if (!destino.ok) {
        logger.error({ leadId: lead.id, code: 'invalid_recipient_phone' }, 'WhatsApp AI reply blocked: no valid canonical phone for lead');
      } else if (accessToken) {
        try {
          await sendWhatsAppMessage(integration.external_id, accessToken, destino.phone, resultado.resposta);
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
