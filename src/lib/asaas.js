import 'dotenv/config';

// Sandbox e produção usam hosts diferentes. Trocar ASAAS_ENV pra 'production'
// quando migrar a chave de API pra uma chave de produção de verdade.
const ASAAS_BASE_URL =
  process.env.ASAAS_ENV === 'production'
    ? 'https://api.asaas.com/v3'
    : 'https://sandbox.asaas.com/api/v3';

async function asaasFetch(path, options = {}) {
  const resp = await fetch(`${ASAAS_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      access_token: process.env.ASAAS_API_KEY,
      ...options.headers,
    },
  });

  const data = await resp.json();
  if (!resp.ok) {
    const mensagem = data?.errors?.[0]?.description || 'Erro na comunicação com o Asaas';
    const erro = new Error(mensagem);
    erro.asaasErrors = data?.errors;
    throw erro;
  }
  return data;
}

// Cria (ou reaproveita, se já existir pelo cpfCnpj) o cliente no Asaas.
export async function criarClienteAsaas({ nome, email, cpfCnpj, telefone }) {
  return asaasFetch('/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: nome,
      email,
      cpfCnpj: cpfCnpj?.replace(/\D/g, ''),
      mobilePhone: telefone?.replace(/\D/g, ''),
    }),
  });
}

const CICLO_POR_PERIODICIDADE = {
  mensal: 'MONTHLY',
  trimestral: 'QUARTERLY',
  semestral: 'SEMIANNUALLY',
  anual: 'YEARLY',
};

// Cria a assinatura recorrente cobrando no cartão de crédito informado.
// remoteIp é exigido pelo Asaas por antifraude.
export async function criarAssinaturaCartao({
  customerId,
  valor,
  periodicidade,
  descricao,
  cartao,
  titular,
  remoteIp,
}) {
  return asaasFetch('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: 'CREDIT_CARD',
      cycle: CICLO_POR_PERIODICIDADE[periodicidade],
      value: valor,
      description: descricao,
      nextDueDate: new Date().toISOString().slice(0, 10),
      creditCard: {
        holderName: cartao.nomeTitular,
        number: cartao.numero,
        expiryMonth: cartao.mesValidade,
        expiryYear: cartao.anoValidade,
        ccv: cartao.ccv,
      },
      creditCardHolderInfo: {
        name: titular.nome,
        email: titular.email,
        cpfCnpj: titular.cpfCnpj?.replace(/\D/g, ''),
        postalCode: titular.cep?.replace(/\D/g, ''),
        addressNumber: titular.numeroEndereco,
        phone: titular.telefone?.replace(/\D/g, ''),
      },
      remoteIp,
    }),
  });
}
