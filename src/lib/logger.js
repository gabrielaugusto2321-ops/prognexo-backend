import pino from 'pino';

export const redactPaths = [
  'req.headers.authorization','req.headers.cookie','res.headers.set-cookie','req.query.secret','req.query.token',
  '*.password','*.ccv','*.number','*.numero','*.cartao','*.access_token','*.refresh_token','*.webhook_token',
  '*.cpfCnpj','*.telefone','*.conteudo','*.mensagem',
  'password','ccv','number','numero','cartao','access_token','refresh_token','webhook_token','cpfCnpj','telefone','conteudo','mensagem'
];

export function createLogger(destination) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: { paths: redactPaths, censor: '[REDACTED]' },
  }, destination);
}

export const logger = createLogger();
