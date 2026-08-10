import { google } from 'googleapis';
import { supabase } from './supabase.js';

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Monta a URL de autorização — o closer/médico clica nela pra conectar
export function buildAuthUrl(state) {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline', // necessário pra ganhar o refresh_token
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state,
  });
}

// Troca o código que o Google manda de volta por tokens de acesso reais
export async function trocarCodigoPorTokens(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// Monta um client autenticado pra fazer chamadas em nome de um usuário específico
async function getClientParaUsuario(userId) {
  const { data } = await supabase.from('google_tokens').select('*').eq('user_id', userId).maybeSingle();
  if (!data) return null;

  const client = getOAuthClient();
  client.setCredentials({ refresh_token: data.refresh_token });
  return client;
}

// Garante que o usuário tenha um calendário dedicado "Prognexo - Nome",
// separado da agenda pessoal dele. Cria na primeira vez, reaproveita depois.
async function garantirCalendarioDedicado(userId, nomeUsuario) {
  const { data: tokenRow } = await supabase.from('google_tokens').select('calendar_id').eq('user_id', userId).single();
  if (tokenRow?.calendar_id) return tokenRow.calendar_id;

  const client = await getClientParaUsuario(userId);
  const calendar = google.calendar({ version: 'v3', auth: client });

  const { data: novoCalendario } = await calendar.calendars.insert({
    requestBody: { summary: `Prognexo - ${nomeUsuario}` },
  });

  await supabase.from('google_tokens').update({ calendar_id: novoCalendario.id }).eq('user_id', userId);
  return novoCalendario.id;
}

// Cria o evento no Google Calendar dedicado da pessoa. Retorna o ID do
// evento lá (guardamos isso pra referência futura), ou null se a pessoa
// não tiver conectado o Google ainda — nesse caso o evento só existe no Prognexo.
export async function criarEventoNoGoogle(userId, nomeUsuario, { titulo, inicio, fim }) {
  const client = await getClientParaUsuario(userId);
  if (!client) return null;

  const calendarId = await garantirCalendarioDedicado(userId, nomeUsuario);
  const calendar = google.calendar({ version: 'v3', auth: client });

  const { data: evento } = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: titulo,
      start: { dateTime: inicio },
      end: { dateTime: fim || new Date(new Date(inicio).getTime() + 3600000).toISOString() },
    },
  });

  return evento.id;
}

// Checa se a pessoa já tem algo marcado nesse horário — olhando a agenda
// PESSOAL dela (primary) e o calendário dedicado do Prognexo, sem nunca
// expor o conteúdo desses compromissos, só se está livre ou ocupado.
export async function temConflito(userId, inicio, fim) {
  const client = await getClientParaUsuario(userId);
  if (!client) return false; // sem Google conectado, não tem como checar

  const { data: tokenRow } = await supabase.from('google_tokens').select('calendar_id').eq('user_id', userId).single();
  const calendar = google.calendar({ version: 'v3', auth: client });

  const items = [{ id: 'primary' }];
  if (tokenRow?.calendar_id) items.push({ id: tokenRow.calendar_id });

  const { data } = await calendar.freebusy.query({
    requestBody: { timeMin: inicio, timeMax: fim, items },
  });

  return Object.values(data.calendars || {}).some((cal) => (cal.busy || []).length > 0);
}

export async function estaConectado(userId) {
  const { data } = await supabase.from('google_tokens').select('user_id').eq('user_id', userId).maybeSingle();
  return !!data;
}
