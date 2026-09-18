// FASE 2 — conta EXATAMENTE o mesmo conjunto de leads que o disparo real
// (dispatch/legado) vai enumerar. Usado como gate de limite de destinatários
// ANTES de criar qualquer ledger/job ou enviar qualquer mensagem — nunca um
// critério diferente do usado na hora de enviar de verdade, senão o gate e o
// envio podem discordar sobre "quantos destinatários" a campanha tem.
export async function resolveCampaignImportLeadIds(client, importId) {
  if (!importId) return null;
  const { data, error } = await client.from('lead_import_rows').select('lead_id')
    .eq('import_id', importId).in('status', ['criado', 'atualizado']);
  if (error) throw error;
  return [...new Set((data || []).map((row) => row.lead_id).filter(Boolean))];
}

export async function countCampaignSendableRecipients(client, campanha) {
  const importIds = await resolveCampaignImportLeadIds(client, campanha.import_id);
  if (importIds && importIds.length === 0) return 0;
  let query = client.from('leads').select('id')
    .eq('doctor_id', campanha.doctor_id).eq('whatsapp_authorization_status', 'autorizado');
  if (campanha.filtro_status) query = query.eq('status_atual', campanha.filtro_status);
  if (importIds) query = query.in('id', importIds);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).length;
}
