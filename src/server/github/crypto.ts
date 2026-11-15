import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

/** AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` binds the ciphertext to a context (e.g. user id). */
export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes.');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [
    VERSION,
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

export function decryptSecret(blob: string, key: Buffer, aad: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== VERSION || !iv || !tag || !ct) throw new Error('Unsupported secret format.');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export function hmac(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(`${purpose}\0${value}`).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Signed, expiring cookie value: `<payload>.<exp>.<sig>`. */
export function signValue(
  secret: string,
  purpose: string,
  payload: string,
  ttlSec: number,
  now = Date.now(),
): string {
  if (payload.includes('.')) throw new Error('Payload must not contain ".".');
  const exp = Math.floor(now / 1000) + ttlSec;
  return `${payload}.${exp}.${hmac(secret, purpose, `${payload}.${exp}`)}`;
}

export function verifyValue(
  secret: string,
  purpose: string,
  token: string | undefined,
  now = Date.now(),
): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [payload, exp, sig] = parts as [string, string, string];
  if (!safeEqual(sig, hmac(secret, purpose, `${payload}.${exp}`))) return null;
  if (!Number.isFinite(Number(exp)) || Number(exp) * 1000 < now) return null;
  return payload;
}
