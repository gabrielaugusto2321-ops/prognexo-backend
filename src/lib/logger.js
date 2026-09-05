import pino from 'pino';

export const redactPaths = [
  'req.headers.authorization','req.headers.cookie','res.headers.set-cookie','req.query.secret','req.query.token',
  'req.headers.x-prognexo-job-token',
  '*.password','*.ccv','*.number','*.numero','*.cartao','*.access_token','*.refresh_token','*.webhook_token',
  '*.access_token_encrypted','*.refresh_token_encrypted','*.webhook_token_encrypted','*.webhook_token_lookup',
  '*.TOKEN_ENCRYPTION_KEYRING','*.TOKEN_ENCRYPTION_ACTIVE_KEY','*.TOKEN_LOOKUP_HMAC_KEY',
  '*.cpfCnpj','*.telefone','*.conteudo','*.mensagem',
  'password','ccv','number','numero','cartao','access_token','refresh_token','webhook_token','cpfCnpj','telefone','conteudo','mensagem',
  'access_token_encrypted','refresh_token_encrypted','webhook_token_encrypted','webhook_token_lookup',
  'TOKEN_ENCRYPTION_KEYRING','TOKEN_ENCRYPTION_ACTIVE_KEY','TOKEN_LOOKUP_HMAC_KEY'
];

export function createLogger(destination) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: { paths: redactPaths, censor: '[REDACTED]' },
  }, destination);
}

export const logger = createLogger();
