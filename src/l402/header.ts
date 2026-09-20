/**
 * L402 HTTP header syntax (protocol-specification.md §5, aperture `l402/header.go`).
 *
 *   WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"
 *   Authorization:    L402 <base64(macaroon)>:<hex(preimage)>
 *
 * Both the `L402` and legacy `LSAT` scheme names are accepted on parse.
 */
import { fromBase64, fromHex, toBase64, toHex } from './bytes.js';
import { Macaroon } from './macaroon.js';

export interface L402Challenge { macaroon: Macaroon; invoice: string }
export interface L402Credential { macaroon: Macaroon; preimage: Uint8Array }

export const SCHEME = 'L402';
export const LEGACY_SCHEME = 'LSAT';

export function formatChallenge(c: L402Challenge, scheme: string = SCHEME): string {
  return `${scheme} macaroon="${toBase64(c.macaroon.serialize())}", invoice="${c.invoice}"`;
}

const CHALLENGE_RE = /^(?:L402|LSAT)\s+macaroon="([A-Za-z0-9+/=]+)",\s*invoice="([A-Za-z0-9]+)"$/i;

export function parseChallenge(header: string): L402Challenge {
  const m = CHALLENGE_RE.exec(header.trim());
  if (!m) throw new Error('invalid L402 challenge header');
  return { macaroon: Macaroon.deserialize(fromBase64(m[1]!)), invoice: m[2]! };
}

export function formatCredential(c: L402Credential, scheme: string = SCHEME): string {
  if (c.preimage.length !== 32) throw new Error('preimage must be 32 bytes');
  return `${scheme} ${toBase64(c.macaroon.serialize())}:${toHex(c.preimage)}`;
}

// Same shape as aperture's authRegex: `(LSAT|L402) (.*?):([a-f0-9]{64})`, anchored.
const CREDENTIAL_RE = /^(?:L402|LSAT)\s+([A-Za-z0-9+/=]+):([a-f0-9]{64})$/i;

export function parseCredential(header: string): L402Credential {
  const m = CREDENTIAL_RE.exec(header.trim());
  if (!m) throw new Error('invalid L402 credential header');
  return { macaroon: Macaroon.deserialize(fromBase64(m[1]!)), preimage: fromHex(m[2]!.toLowerCase()) };
}
