import crypto from 'crypto';

export function safeEqual(a, b) {
  const left = Buffer.from(String(a || '')); const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
export function verifyHmac({ algorithm, secret, rawBody, provided, prefix = '' }) {
  if (!secret || !rawBody || !provided) return false;
  const expected = prefix + crypto.createHmac(algorithm, secret).update(rawBody).digest('hex');
  return safeEqual(expected, provided);
}
