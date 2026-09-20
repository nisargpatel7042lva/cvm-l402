import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatChallenge, formatCredential, parseChallenge, parseCredential } from './header.js';
import { Macaroon } from './macaroon.js';
import { toBase64, toHex } from './bytes.js';

const root = new Uint8Array(32).fill(1);
const id = new Uint8Array(66).fill(2);
const mac = Macaroon.create(root, id, 'lsat').addFirstPartyCaveat('services=demo:0');
const invoice = 'lnbcrt210n1p4tqyrrpp56gfhzx4scjrhxfqzsne7frgd5288k28746mlnlgtqk3ylqtn6w5fsdqqcqzzsxqyz5vqsp5';
const preimage = new Uint8Array(32).fill(0xaa);

test('challenge header matches spec §5.1 syntax and round-trips', () => {
  const h = formatChallenge({ macaroon: mac, invoice });
  assert.equal(h, `L402 macaroon="${toBase64(mac.serialize())}", invoice="${invoice}"`);
  const parsed = parseChallenge(h);
  assert.equal(parsed.invoice, invoice);
  assert.deepEqual(parsed.macaroon.serialize(), mac.serialize());
});

test('legacy LSAT scheme is accepted on parse', () => {
  const h = formatChallenge({ macaroon: mac, invoice }, 'LSAT');
  assert.ok(h.startsWith('LSAT '));
  assert.equal(parseChallenge(h).invoice, invoice);
  assert.ok(parseCredential(formatCredential({ macaroon: mac, preimage }, 'LSAT')).macaroon.verifySignature(root));
});

test('credential header is "L402 <b64 mac>:<hex preimage>" and round-trips', () => {
  const h = formatCredential({ macaroon: mac, preimage });
  assert.equal(h, `L402 ${toBase64(mac.serialize())}:${toHex(preimage)}`);
  const parsed = parseCredential(h);
  assert.deepEqual(parsed.preimage, preimage);
  assert.ok(parsed.macaroon.verifySignature(root));
});

test('malformed headers are rejected', () => {
  assert.throws(() => parseChallenge('Basic abc'), /invalid L402 challenge/);
  assert.throws(() => parseChallenge('L402 macaroon="!!", invoice="x"'), /invalid/);
  assert.throws(() => parseCredential('L402 abc'), /invalid L402 credential/);
  assert.throws(() => parseCredential(`L402 ${toBase64(mac.serialize())}:abcd`), /invalid L402 credential/); // preimage must be 64 hex
  assert.throws(() => parseCredential(`L402 ${toBase64(mac.serialize())}:${'g'.repeat(64)}`), /invalid/);
  assert.throws(() => formatCredential({ macaroon: mac, preimage: new Uint8Array(31) }), /32 bytes/);
});
