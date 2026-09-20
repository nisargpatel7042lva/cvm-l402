import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Macaroon } from './macaroon.js';
import { fromHex, sha256, toHex, utf8 } from './bytes.js';

// Independent vector generated with pymacaroons (libmacaroons-compatible, same
// "macaroons-key-generator" derivation and V2 binary format as gopkg.in/macaroon.v2):
//   root = bytes(range(32)); id = 0x0000 || sha256("preimage-test") || 0x11*32; location "lsat"
//   caveats: "services=demo:0", "demo_valid_until=1800000000"
const ROOT = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const ID = new Uint8Array([0, 0, ...sha256(utf8('preimage-test')), ...new Array(32).fill(0x11)]);
const EXPECTED_SIG = 'a60ae29387ed367991f453ecb8ba98fe8862233cca4ec429f88acb878e8de98a';
const EXPECTED_RAW =
  '0201046c73617402420000428d6ef6de75aa4d6e44d7643d99dc074fc1e7b3e88d3800e8b728071a9cfa79' +
  '1111111111111111111111111111111111111111111111111111111111111111' +
  '00020f73657276696365733d64656d6f3a3000021b64656d6f5f76616c69645f756e74696c3d31383030303030303030' +
  '00000620a60ae29387ed367991f453ecb8ba98fe8862233cca4ec429f88acb878e8de98a';

function vectorMacaroon(): Macaroon {
  return Macaroon.create(ROOT, ID, 'lsat').addFirstPartyCaveat('services=demo:0').addFirstPartyCaveat('demo_valid_until=1800000000');
}

test('signature chain matches pymacaroons/macaroon.v2 vector', () => {
  assert.equal(toHex(vectorMacaroon().signature), EXPECTED_SIG);
});

test('V2 serialization is byte-identical to reference', () => {
  assert.equal(toHex(vectorMacaroon().serialize()), EXPECTED_RAW);
});

test('deserialize(reference bytes) round-trips and verifies', () => {
  const m = Macaroon.deserialize(fromHex(EXPECTED_RAW));
  assert.equal(m.location, 'lsat');
  assert.deepEqual(m.identifier, ID);
  assert.deepEqual([...m.caveats], ['services=demo:0', 'demo_valid_until=1800000000']);
  assert.ok(m.verifySignature(ROOT));
  assert.equal(toHex(m.serialize()), EXPECTED_RAW);
});

test('verifySignature rejects wrong root key', () => {
  const wrong = new Uint8Array(32).fill(7);
  assert.equal(vectorMacaroon().verifySignature(wrong), false);
});

test('tampering with a caveat breaks the chain', () => {
  const raw = fromHex(EXPECTED_RAW);
  // flip a byte inside "services=demo:0" → "services=demo:1"
  const idx = toHex(raw).indexOf('64656d6f3a30') / 2 + 5;
  raw[idx] = 0x31;
  const m = Macaroon.deserialize(raw);
  assert.equal(m.caveats[0], 'services=demo:1');
  assert.equal(m.verifySignature(ROOT), false);
});

test('holder can attenuate without root key; attenuated macaroon still verifies', () => {
  const m = Macaroon.deserialize(fromHex(EXPECTED_RAW));
  m.addFirstPartyCaveat('demo_valid_until=1700000000');
  assert.ok(m.verifySignature(ROOT));
  assert.equal(m.caveats.length, 3);
});

test('caveat removal is detected', () => {
  const m = Macaroon.deserialize(fromHex(EXPECTED_RAW));
  const stripped = Macaroon.create(ROOT, ID, 'lsat').addFirstPartyCaveat('services=demo:0');
  // forge: take the fully-caveated signature but claim only one caveat
  const forged = Macaroon.deserialize(
    new Uint8Array([...stripped.serialize().slice(0, stripped.serialize().length - 34), 0x06, 0x20, ...m.signature]),
  );
  assert.equal(forged.caveats.length, 1);
  assert.equal(forged.verifySignature(ROOT), false);
});

test('varint lengths > 127 encode/decode', () => {
  const longCaveat = 'x=' + 'y'.repeat(300);
  const m = Macaroon.create(ROOT, ID, '').addFirstPartyCaveat(longCaveat);
  const back = Macaroon.deserialize(m.serialize());
  assert.equal(back.location, '');
  assert.equal(back.caveats[0], longCaveat);
  assert.ok(back.verifySignature(ROOT));
});

test('deserialize rejects garbage, wrong version, third-party caveats, trailing data', () => {
  assert.throws(() => Macaroon.deserialize(new Uint8Array([1, 2, 3])), /version/);
  assert.throws(() => Macaroon.deserialize(new Uint8Array([2, 2, 1, 0x41])), /end of data/);
  // third-party caveat: identifier + non-empty vid
  const tp = new Uint8Array([2, 2, 1, 0x41, 0, 2, 1, 0x63, 4, 1, 0x7a, 0, 0, 6, 32, ...new Array(32).fill(0)]);
  assert.throws(() => Macaroon.deserialize(tp), /third-party/);
  assert.throws(() => Macaroon.deserialize(new Uint8Array([...fromHex(EXPECTED_RAW), 0])), /trailing/);
});
