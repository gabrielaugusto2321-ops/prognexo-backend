// Lead de QUARENTENA de identidade — usado pelo webhook do WhatsApp quando a
// identidade de telefone de um remetente é ambígua (mais de um candidato
// legado do mesmo médico, nenhuma correspondência exata de whatsapp_wa_id).
//
// Extraído do handler do webhook para ser testável isoladamente e para
// centralizar a resolução da corrida concorrente: duas mensagens do MESMO
// wa_id podem chegar quase ao mesmo tempo (dois webhooks em paralelo) e as
// duas caem na ambiguidade — só uma pode criar o lead, a outra tem que achar
// o que a primeira criou, nunca duplicar nem virar erro 500.

const CONCURRENT_UNIQUE_VIOLATION = '23505';

// Nunca inclui telefone/mensagem de erro do banco (que pode conter o valor
// da chave em DETAIL) — só um código estável para log/observabilidade.
function sanitizedFailure(code) {
  return Object.assign(new Error(code), { code });
}

// Resolve (busca ou cria) o lead de quarentena para doctor_id+whatsapp_wa_id.
// Fluxo obrigatório:
//   1. busca exata por doctor_id + whatsapp_wa_id;
//   2. se não existir, tenta inserir;
//   3. se o insert violar o índice único (23505 — outra mensagem concorrente
//      venceu a corrida), busca de novo — nunca trata isso como erro;
//   4. usa o lead encontrado (criado por esta chamada ou pela concorrente);
//   5. se mesmo assim não encontrar após a violação, falha de forma
//      explícita e sanitizada (nunca segue adiante sem lead resolvido).
//
// Nunca sobrescreve nome/dados_extraidos/consentimento/telefone_normalizado
// de um lead já existente — só faz UPDATE nenhum aqui; um lead achado (seja
// por já existir, seja pela corrida) é usado exatamente como está.
export async function resolveQuarantineLead({
  supabase, doctorId, organizationId, rawDigits, telefoneOriginal, nome, select,
  reason = 'ambiguous_candidates',
}) {
  const lookup = () => supabase
    .from('leads')
    .select(select)
    .eq('doctor_id', doctorId)
    .eq('whatsapp_wa_id', rawDigits)
    .maybeSingle();

  const { data: existing } = await lookup();
  if (existing) return { lead: existing, created: false };

  const { data: inserted, error: insertError } = await supabase
    .from('leads')
    .insert({
      doctor_id: doctorId,
      ...(organizationId ? { organization_id: organizationId } : {}),
      telefone: telefoneOriginal,
      whatsapp_wa_id: rawDigits || null,
      telefone_normalizado: null,
      whatsapp_authorization_status: 'pendente',
      nome,
      status_atual: 'lead',
      journey_type: 'low_ticket',
      dados_extraidos: { phone_identity_review_required: true, phone_identity_reason: reason },
    })
    .select(select)
    .single();

  if (!insertError) return { lead: inserted, created: true };

  if (insertError.code === CONCURRENT_UNIQUE_VIOLATION) {
    // Corrida esperada: outra mensagem concorrente do MESMO wa_id já criou o
    // lead entre a nossa busca e o nosso insert. Nunca é um erro de verdade
    // — busca de novo e reaproveita o que a concorrente criou.
    const { data: found } = await lookup();
    if (found) return { lead: found, created: false };
    // A violação prova que a linha existe; se mesmo assim a segunda busca
    // não a encontrar (ex.: falha de leitura), não seguimos sem lead
    // resolvido — falha explícita e sanitizada, nunca um 500 disfarçado.
    throw sanitizedFailure('quarantine_lead_unresolved');
  }

  throw sanitizedFailure('quarantine_lead_insert_failed');
}
