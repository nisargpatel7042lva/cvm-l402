/**
 * L402 macaroon identifier (version 0), per lightninglabs/aperture `l402/identifier.go`:
 *
 *   uint16 BE version (0) || 32-byte payment hash || 32-byte token id   = 66 bytes
 */
import { concat, random32 } from './bytes.js';

export const IDENTIFIER_VERSION = 0;
export const IDENTIFIER_SIZE = 2 + 32 + 32;

export interface L402Identifier {
  version: number;
  paymentHash: Uint8Array; // 32 bytes
  tokenId: Uint8Array;     // 32 bytes
}

export function encodeIdentifier(id: L402Identifier): Uint8Array {
  if (id.version !== IDENTIFIER_VERSION) throw new Error(`unknown L402 version ${id.version}`);
  if (id.paymentHash.length !== 32) throw new Error('payment hash must be 32 bytes');
  if (id.tokenId.length !== 32) throw new Error('token id must be 32 bytes');
  const version = new Uint8Array([(id.version >> 8) & 0xff, id.version & 0xff]);
  return concat(version, id.paymentHash, id.tokenId);
}

export function decodeIdentifier(bytes: Uint8Array): L402Identifier {
  if (bytes.length < 2) throw new Error('identifier too short');
  const version = (bytes[0]! << 8) | bytes[1]!;
  if (version !== IDENTIFIER_VERSION) throw new Error(`unknown L402 version ${version}`);
  if (bytes.length !== IDENTIFIER_SIZE) throw new Error(`identifier must be ${IDENTIFIER_SIZE} bytes, got ${bytes.length}`);
  return { version, paymentHash: bytes.slice(2, 34), tokenId: bytes.slice(34, 66) };
}

/** Fresh identifier committing to `paymentHash` with a random token id. */
export function newIdentifier(paymentHash: Uint8Array): L402Identifier {
  return { version: IDENTIFIER_VERSION, paymentHash, tokenId: random32() };
}
