import crypto from 'crypto';
import { env } from '../config/env.js';

function secret() {
  if (env.LEAD_FORM_EMBED_SECRET) return Buffer.from(env.LEAD_FORM_EMBED_SECRET);
  return crypto.createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY || '').update('lead-form-embed-v1').digest();
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function sign(body) { return crypto.createHmac('sha256', secret()).update(body).digest('base64url'); }

export function createLeadFormToken({ pid, host, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const body = encode({ pid, host, iat, exp: iat + 1800 });
  return `${body}.${sign(body)}`;
}

export function verifyLeadFormToken(token, { pid, now = Date.now() }) {
  try {
    const [body, signature, extra] = String(token || '').split('.');
    if (!body || !signature || extra) return null;
    const expected = Buffer.from(sign(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const seconds = Math.floor(now / 1000);
    if (payload.pid !== pid || typeof payload.host !== 'string' || !Number.isInteger(payload.iat)
      || !Number.isInteger(payload.exp) || payload.exp < seconds || payload.iat > seconds + 30) return null;
    return payload;
  } catch { return null; }
}
