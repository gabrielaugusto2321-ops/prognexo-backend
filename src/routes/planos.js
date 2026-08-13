import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../lib/supabase.js';
import { criarClienteAsaas, criarAssinaturaCartao } from '../lib/asaas.js';
import { enviarEmail, emailBoasVindasHtml } from '../lib/resend.js';

const router = Router();

const PRECOS = {
  vendas: { mensal: 197, trimestral: 167, semestral: 147, anual: 117 },
  combo: { mensal: 247, trimestral: 247, semestral: 247, anual: 247 },
};

const LOGIN_URL = process.env.FRONTEND_URL
  ? `${process.env.FRONTEND_URL}/#/login`
  : 'https://prognexo-frontend.vercel.app/#/login';

function gerarSenhaTemporaria() {
  return crypto.randomBytes(6).toString('base64url'); // ex: "kQ9f_2Lm"
}

// POST /planos/assinar — rota PÚBLICA (sem login), usada pela tela "Meu plano".
// Body: {
//   nome, clinica, email, telefone, cpfCnpj, cep, numeroEndereco,
//   modulo: 'vendas' | 'combo',
//   periodicidade: 'mensal' | 'trimestral' | 'semestral' | 'anual',
//   cartao: { nomeTitular, numero, mesValidade, anoValidade, ccv }
// }
router.post('/assinar', async (req, res) => {
  const {
    nome,
    clinica,
    email,
    telefone,
    cpfCnpj,
    cep,
    numeroEndereco,
    modulo,
    periodicidade,
    cartao,
  } = req.body;

  if (!nome || !email || !cpfCnpj || !modulo || !periodicidade || !cartao) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }
  if (!PRECOS[modulo]?.[periodicidade]) {
    return res.status(400).json({ error: 'Plano ou periodicidade inválidos' });
  }

  const valor = PRECOS[modulo][periodicidade];

  // 1. Cobra o cartão no Asaas ANTES de criar qualquer coisa no Prognexo —
  // se o pagamento falhar, não sobra conta órfã sem assinatura ativa.
  let assinaturaAsaas;
  try {
    const cliente = await criarClienteAsaas({ nome, email, cpfCnpj, telefone });
    assinaturaAsaas = await criarAssinaturaCartao({
      customerId: cliente.id,
      valor,
      periodicidade,
      descricao: `Prognexo — Plano ${modulo === 'combo' ? 'Combo' : 'Vendas'} (${periodicidade})`,
      cartao,
      titular: { nome, email, cpfCnpj, cep, numeroEndereco, telefone },
      remoteIp: req.ip,
    });
  } catch (err) {
    return res.status(402).json({ error: err.message || 'Pagamento recusado' });
  }

  // 2. Pagamento aprovado — cria a conta de acesso com senha gerada
  const senha = gerarSenhaTemporaria();
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
  });
  if (authError) {
    return res.status(500).json({ error: `Pagamento aprovado, mas falha ao criar conta: ${authError.message}` });
  }

  const { error: userError } = await supabase.from('users').insert({
    id: authUser.user.id,
    nome,
    email,
    role: 'doctor',
  });
  if (userError) {
    return res.status(500).json({ error: `Pagamento aprovado, mas falha ao criar usuário: ${userError.message}` });
  }

  const { error: doctorError } = await supabase.from('doctors').insert({
    owner_user_id: authUser.user.id,
    nome: clinica || nome,
    status: 'ativo',
    plano: 'pago',
    modulo,
    periodicidade,
    asaas_customer_id: assinaturaAsaas.customer,
    asaas_subscription_id: assinaturaAsaas.id,
    assinatura_status: 'ativa',
  });
  if (doctorError) {
    return res.status(500).json({ error: `Pagamento aprovado, mas falha ao criar médico: ${doctorError.message}` });
  }

  // 3. Manda a senha por e-mail. Se o e-mail falhar, não desfaz o cadastro —
  // devolve a senha na resposta como plano B pra tela mostrar na hora.
  let emailEnviado = true;
  try {
    await enviarEmail({
      to: email,
      subject: 'Bem-vindo ao Prognexo — seus dados de acesso',
      html: emailBoasVindasHtml({ nome, email, senha, loginUrl: LOGIN_URL }),
    });
  } catch (err) {
    emailEnviado = false;
  }

  res.status(201).json({
    ok: true,
    emailEnviado,
    // Só devolvido pro frontend mostrar na tela se o e-mail falhar —
    // nunca logar isso em lugar nenhum.
    senhaTemporaria: emailEnviado ? undefined : senha,
  });
});

export default router;
