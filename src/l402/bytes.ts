/** Small byte/crypto helpers shared by the L402 primitives. Node-only (node:crypto). */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

export const hmacSha256 = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac('sha256', key).update(data).digest());

export const random32 = (): Uint8Array => new Uint8Array(randomBytes(32));

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const fromHex = (h: string): Uint8Array => {
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error('invalid hex');
  return new Uint8Array(Buffer.from(h, 'hex'));
};

/** RFC 4648 standard base64 with padding (what Aperture uses in headers). */
export const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
export const fromBase64 = (s: string): Uint8Array => {
  if (/[^A-Za-z0-9+/=]/.test(s)) throw new Error('invalid base64');
  return new Uint8Array(Buffer.from(s, 'base64'));
};

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && timingSafeEqual(a, b);
