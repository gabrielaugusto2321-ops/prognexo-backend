import { env } from '../config/env.js';
import { logger } from './logger.js';

export async function verifyCaptcha(token, ip) {
  if (env.CAPTCHA_ENABLED !== 'true') return env.NODE_ENV !== 'production';
  if (!env.CAPTCHA_SECRET || !token) return false;
  if (env.CAPTCHA_PROVIDER !== 'turnstile') { logger.warn({ provider: env.CAPTCHA_PROVIDER }, 'Unsupported CAPTCHA provider'); return false; }
  try {
    const body = new URLSearchParams({ secret: env.CAPTCHA_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) });
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const result = await response.json();
    return response.ok && result.success === true;
  } catch (error) { logger.error({ err: error }, 'CAPTCHA verification failed'); return false; }
}
