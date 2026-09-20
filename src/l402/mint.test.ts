import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mint, MemorySecretStore, L402VerifyError, type Challenger } from './mint.js';
import { decodeIdentifier } from './identifier.js';
import { formatCredential, parseCredential, parseChallenge, formatChallenge } from './header.js';
import { random32, sha256 } from './bytes.js';
import { Macaroon } from './macaroon.js';

/** Fake Lightning: "invoice" is just a label; the preimage is known to the test. */
function fakeChallenger() {
  const preimages = new Map<string, Uint8Array>();
  const challenger: Challenger = {
    async newChallenge(amountSat) {
      const preimage = random32();
      const paymentHash = sha256(preimage);
      const invoice = `fakeinvoice${amountSat}sat${preimages.size}`;
      preimages.set(invoice, preimage);
      return { invoice, paymentHash };
    },
  };
  return { challenger, pay: (invoice: string) => preimages.get(invoice)! };
}

const svc = { name: 'weather', tier: 0 };

test('mint → pay → verify (happy path, stateless preimage check + signature + caveats)', async () => {
  const { challenger, pay } = fakeChallenger();
  const store = new MemorySecretStore();
  const mint = new Mint({ challenger, secrets: store, now: () => 1000 });

  const { macaroon, invoice, paymentHash } = await mint.mint({ service: svc, amountSat: 21, validForSeconds: 60 });
  assert.equal(store.size, 1);
  assert.deepEqual(decodeIdentifier(macaroon.identifier).paymentHash, paymentHash);
  assert.deepEqual([...macaroon.caveats], ['services=weather:0', 'weather_valid_until=1060']);

  // Simulate the wire: challenge header → client → credential header → server.
  const ch = parseChallenge(formatChallenge({ macaroon, invoice }));
  const cred = parseCredential(formatCredential({ macaroon: ch.macaroon, preimage: pay(ch.invoice) }));
  const id = await mint.verify({ ...cred, targetService: 'weather' });
  assert.deepEqual(id.paymentHash, paymentHash);
});

async function rejects(p: Promise<unknown>, reason: L402VerifyError['reason']) {
  await assert.rejects(p, (e: unknown) => e instanceof L402VerifyError && e.reason === reason);
}

test('wrong preimage → invalid_preimage', async () => {
  const { challenger } = fakeChallenger();
  const mint = new Mint({ challenger });
  const { macaroon } = await mint.mint({ service: svc, amountSat: 1 });
  await rejects(mint.verify({ macaroon, preimage: random32(), targetService: 'weather' }), 'invalid_preimage');
});

test('macaroon minted elsewhere (unknown root key) → unknown_macaroon', async () => {
  const { challenger, pay } = fakeChallenger();
  const a = new Mint({ challenger });
  const b = new Mint({ challenger });
  const { macaroon, invoice } = await a.mint({ service: svc, amountSat: 1 });
  await rejects(b.verify({ macaroon, preimage: pay(invoice), targetService: 'weather' }), 'unknown_macaroon');
});

test('revoked macaroon → unknown_macaroon', async () => {
  const { challenger, pay } = fakeChallenger();
  const mint = new Mint({ challenger });
  const { macaroon, invoice } = await mint.mint({ service: svc, amountSat: 1 });
  await mint.revoke(macaroon);
  await rejects(mint.verify({ macaroon, preimage: pay(invoice), targetService: 'weather' }), 'unknown_macaroon');
});

test('tampered caveat (same identifier, forged sig) → bad_signature', async () => {
  const { challenger, pay } = fakeChallenger();
  const mint = new Mint({ challenger });
  const { macaroon, invoice } = await mint.mint({ service: svc, amountSat: 1 });
  const forged = Macaroon.create(new Uint8Array(32), macaroon.identifier, 'lsat').addFirstPartyCaveat('services=weather:0,admin:0');
  await rejects(mint.verify({ macaroon: forged, preimage: pay(invoice), targetService: 'admin' }), 'bad_signature');
});

test('valid macaroon for a different service → caveat', async () => {
  const { challenger, pay } = fakeChallenger();
  const mint = new Mint({ challenger });
  const { macaroon, invoice } = await mint.mint({ service: svc, amountSat: 1 });
  await rejects(mint.verify({ macaroon, preimage: pay(invoice), targetService: 'geo' }), 'caveat');
});

test('expired macaroon → caveat; holder-attenuated shorter expiry is honoured', async () => {
  const { challenger, pay } = fakeChallenger();
  let now = 1000;
  const mint = new Mint({ challenger, now: () => now });
  const { macaroon, invoice } = await mint.mint({ service: svc, amountSat: 1, validForSeconds: 100 });
  const preimage = pay(invoice);
  await mint.verify({ macaroon, preimage, targetService: 'weather' });
  now = 1101;
  await rejects(mint.verify({ macaroon, preimage, targetService: 'weather' }), 'caveat');

  now = 1000;
  macaroon.addFirstPartyCaveat('weather_valid_until=1050');
  await mint.verify({ macaroon, preimage, targetService: 'weather' });
  now = 1051;
  await rejects(mint.verify({ macaroon, preimage, targetService: 'weather' }), 'caveat');
});

test('malformed identifier → malformed', async () => {
  const { challenger } = fakeChallenger();
  const mint = new Mint({ challenger });
  const bad = Macaroon.create(new Uint8Array(32), new Uint8Array([0, 0, 1]), 'lsat');
  await rejects(mint.verify({ macaroon: bad, preimage: random32(), targetService: 'weather' }), 'malformed');
});
