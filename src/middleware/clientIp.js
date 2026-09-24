import net from 'node:net';
import { env } from '../config/env.js';

// Atrás do Render, todo tráfego passa pelo Cloudflare. Com `trust proxy = 1` o
// Express entrega em req.ip o IP de uma BORDA do Cloudflare — que varia de uma
// requisição para outra do mesmo visitante e é compartilhado por visitantes
// diferentes. Efeito medido em produção: o contador de rate limit de um único
// cliente pulava entre vários baldes (limite diluído) e visitantes na mesma
// borda dividiam o mesmo balde (limite injusto).
//
// O Cloudflare sobrescreve `CF-Connecting-IP` com o IP real de quem conectou a
// ele; um cliente não consegue forjá-lo enquanto o serviço só for alcançável
// via Cloudflare. Por isso a flag é EXPLÍCITA (TRUST_CLOUDFLARE_HEADERS=true) e
// nasce desligada: ligar num ambiente sem Cloudflare na frente deixaria
// qualquer um escolher o próprio IP.
export function resolveCloudflareClientIp(req, trust = env.TRUST_CLOUDFLARE_HEADERS === 'true') {
  if (!trust) return null;
  // Defesa em profundidade: toda requisição que passou pelo Cloudflare tem CF-Ray.
  // Sem ele o header não é confiável (e nem chegou por onde se supõe).
  if (!req.get('cf-ray')) return null;
  const value = req.get('cf-connecting-ip');
  // Cloudflare manda um único IP; qualquer outra coisa (lista, lixo, vazio) é ignorada.
  return typeof value === 'string' && net.isIP(value.trim()) ? value.trim() : null;
}

export function clientIp(req, res, next) {
  const ip = resolveCloudflareClientIp(req);
  // req.ip é um getter do protótipo; sobrescrever aqui faz TODO consumidor
  // (rate limits, CAPTCHA remoteip, hash de IP da captação) enxergar o IP real.
  if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true });
  next();
}
