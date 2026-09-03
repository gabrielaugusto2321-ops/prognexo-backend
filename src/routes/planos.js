import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../lib/supabase.js';
import { criarClienteAsaas, criarAssinaturaCartao } from '../lib/asaas.js';
import { enviarEmail, emailBoasVindasHtml } from '../lib/resend.js';
import { z } from 'zod';
import { env } from '../config/env.js';

const router = Router();

const PRECOS = {
  vendas: { mensal: 197, trimestral: 167, semestral: 147, anual: 117 },
  combo: { mensal: 247, trimestral: 247, semestral: 247, anual: 247 },
};
const checkoutSchema=z.object({nome:z.string().min(2).max(120),clinica:z.string().max(120).optional(),email:z.string().email(),telefone:z.string().min(8).max(30),cpfCnpj:z.string().regex(/^\d{11}|\d{14}$/),cep:z.string().regex(/^\d{8}$/),numeroEndereco:z.string().min(1).max(20),modulo:z.enum(['vendas','combo']),periodicidade:z.enum(['mensal','trimestral','semestral','anual']),cartao:z.object({nomeTitular:z.string().min(2).max(120),numero:z.string().regex(/^\d{13,19}$/),mesValidade:z.string().regex(/^(0[1-9]|1[0-2])$/),anoValidade:z.string().regex(/^\d{4}$/),ccv:z.string().regex(/^\d{3,4}$/)}).strict()}).strict();

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
  if (env.NODE_ENV === 'production' && env.LEGACY_CARD_CHECKOUT_ENABLED !== 'true') return res.status(503).json({ error: 'checkout_indisponivel' });
  const parsed=checkoutSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:'invalid_checkout_data'});
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
  } = parsed.data;

  if (!nome || !email || !cpfCnpj || !modulo || !periodicidade || !cartao) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }
  if (!PRECOS[modulo]?.[periodicidade]) {
    return res.status(400).json({ error: 'Plano ou periodicidade inválidos' });
  }

  const valor = PRECOS[modulo][periodicidade];

  // Confere ANTES de cobrar — evita gerar uma cobrança órfã no Asaas quando
  // o e-mail já tem conta (ex: pessoa tentando assinar de novo por engano).
  const { data: usuarioExistente } = await supabase
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (usuarioExistente) {
    return res.status(409).json({ error: 'Já existe uma conta com esse e-mail. Faça login ou use outro e-mail.' });
  }

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
    req.log?.error({ err }, 'Asaas subscription failed');
    return res.status(402).json({ error: 'pagamento_recusado', requestId: req.id });
  }

  // 2. Pagamento aprovado — cria a conta de acesso com senha gerada
  const senha = gerarSenhaTemporaria();
  const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
  });
  if (authError) {
    req.log?.error({ err: authError }, 'Checkout: auth user creation failed after payment');
    return res.status(500).json({ error: 'provisionamento_falhou', requestId: req.id });
  }

  const { error: userError } = await supabase.from('users').insert({
    id: authUser.user.id,
    nome,
    email,
    role: 'doctor',
  });
  if (userError) {
    req.log?.error({ err: userError }, 'Checkout: user row creation failed after payment');
    return res.status(500).json({ error: 'provisionamento_falhou', requestId: req.id });
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
    req.log?.error({ err: doctorError }, 'Checkout: doctor row creation failed after payment');
    return res.status(500).json({ error: 'provisionamento_falhou', requestId: req.id });
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
    req.log?.error({ err }, 'Checkout: welcome email failed');
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
