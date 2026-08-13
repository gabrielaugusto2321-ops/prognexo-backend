import 'dotenv/config';

// Enquanto não validamos um domínio próprio no Resend, o remetente precisa
// ser o domínio de teste deles. Trocar depois de verificar um domínio.
const REMETENTE_PADRAO = 'Prognexo <onboarding@resend.dev>';

export async function enviarEmail({ to, subject, html }) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from: REMETENTE_PADRAO, to, subject, html }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.message || 'Erro ao enviar e-mail via Resend');
  }
  return data;
}

export function emailBoasVindasHtml({ nome, email, senha, loginUrl }) {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0f172a;">Bem-vindo(a) ao Prognexo, ${nome}!</h2>
      <p>Sua assinatura foi confirmada e sua conta já está pronta. Use os dados abaixo para acessar:</p>
      <table style="margin: 16px 0; font-size: 14px;">
        <tr><td style="padding:4px 8px 4px 0;"><b>E-mail:</b></td><td>${email}</td></tr>
        <tr><td style="padding:4px 8px 4px 0;"><b>Senha:</b></td><td>${senha}</td></tr>
      </table>
      <p><a href="${loginUrl}" style="background:#0f9d6c;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Acessar o Prognexo</a></p>
      <p style="color:#64748b;font-size:12px;">Recomendamos trocar essa senha assim que fizer o primeiro login.</p>
    </div>
  `;
}
