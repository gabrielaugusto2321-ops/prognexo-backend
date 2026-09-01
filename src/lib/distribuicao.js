import { supabase } from './supabase.js';

// Escolhe o closer com menos leads ativos no funil daquele médico —
// retorna null se a distribuição automática estiver desligada, ou se
// o médico não tiver nenhum closer cadastrado ainda.
// Compartilhado entre a atribuição manual (rotas de leads) e o handoff
// automático da IA (webhook do WhatsApp).
export async function escolherCloserAutomatico(doctorId) {
  const { data: doctor } = await supabase.from('doctors').select('distribuicao_automatica').eq('id', doctorId).single();
  if (!doctor?.distribuicao_automatica) return null;

  const { data: membros } = await supabase.from('user_doctor_access').select('user_id').eq('doctor_id', doctorId);
  if (!membros || membros.length === 0) return null;

  const membroIds = membros.map((m) => m.user_id);
  const etapasAtivas = ['lead', 'conversa_iniciada', 'reuniao_marcada', 'proposta'];

  const { data: leadsAtivos } = await supabase
    .from('leads')
    .select('sdr_responsavel_id')
    .eq('doctor_id', doctorId)
    .in('status_atual', etapasAtivas)
    .in('sdr_responsavel_id', membroIds);

  const contagem = {};
  membroIds.forEach((id) => (contagem[id] = 0));
  (leadsAtivos || []).forEach((l) => {
    if (l.sdr_responsavel_id) contagem[l.sdr_responsavel_id] = (contagem[l.sdr_responsavel_id] || 0) + 1;
  });

  return membroIds.reduce((menor, id) => (contagem[id] < contagem[menor] ? id : menor), membroIds[0]);
}
