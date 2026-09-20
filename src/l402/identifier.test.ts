import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeIdentifier, encodeIdentifier, IDENTIFIER_SIZE, newIdentifier } from './identifier.js';

test('identifier encodes as 0x0000 || payment_hash || token_id (66 bytes)', () => {
  const ph = new Uint8Array(32).fill(0xab);
  const tid = new Uint8Array(32).fill(0xcd);
  const bytes = encodeIdentifier({ version: 0, paymentHash: ph, tokenId: tid });
  assert.equal(bytes.length, IDENTIFIER_SIZE);
  assert.deepEqual([...bytes.slice(0, 2)], [0, 0]);
  assert.deepEqual(bytes.slice(2, 34), ph);
  assert.deepEqual(bytes.slice(34), tid);
  assert.deepEqual(decodeIdentifier(bytes), { version: 0, paymentHash: ph, tokenId: tid });
});

test('newIdentifier commits to payment hash with a random token id', () => {
  const ph = new Uint8Array(32).fill(1);
  const a = newIdentifier(ph), b = newIdentifier(ph);
  assert.deepEqual(a.paymentHash, ph);
  assert.notDeepEqual(a.tokenId, b.tokenId);
});

test('decode rejects unknown version and wrong length', () => {
  assert.throws(() => decodeIdentifier(new Uint8Array([0, 1, ...new Array(64).fill(0)])), /unknown L402 version/);
  assert.throws(() => decodeIdentifier(new Uint8Array(65)), /66 bytes/);
  assert.throws(() => encodeIdentifier({ version: 0, paymentHash: new Uint8Array(31), tokenId: new Uint8Array(32) }), /32 bytes/);
});
