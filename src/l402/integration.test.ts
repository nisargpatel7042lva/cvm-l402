/**
 * Integration: full L402 loop against the regtest LND nodes and a real
 * node:http server. Skipped unless infra/creds exists (run infra/setup-ln.sh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { agentLnd, devCredsAvailable, serverLnd } from './dev-nodes.js';
import { LndChallenger } from './lnd-rest.js';
import { Mint } from './mint.js';
import { createL402Guard } from './http-guard.js';
import { L402Payer } from './payer.js';
import { formatCredential, parseChallenge, parseCredential } from './header.js';
import { sha256 } from './bytes.js';

const skip = !devCredsAvailable();

test('regtest: mint via lnd-server, pay via lnd-agent, verify statelessly', { skip }, async () => {
  const mint = new Mint({ challenger: new LndChallenger(serverLnd()) });
  const { macaroon, invoice, paymentHash } = await mint.mint({ service: { name: 'itest', tier: 0 }, amountSat: 5 });

  const payer = new L402Payer({ lnd: agentLnd(), maxAmountSat: 100 });
  const paid = await payer.payChallenge({ macaroon, invoice });
  assert.equal(paid.amountSat, 5);
  assert.deepEqual(sha256(paid.credential.preimage), paymentHash);

  const id = await mint.verify({ ...paid.credential, targetService: 'itest' });
  assert.deepEqual(id.paymentHash, paymentHash);

  // The server's node agrees the invoice settled (not needed for verification, but proves it's real money).
  const status = await serverLnd().lookupInvoice(paymentHash);
  assert.equal(status.settled, true);
  assert.equal(status.amtPaidSat, 5);
});

test('regtest: payer refuses invoices above maxAmountSat', { skip }, async () => {
  const mint = new Mint({ challenger: new LndChallenger(serverLnd()) });
  const ch = await mint.mint({ service: { name: 'itest', tier: 0 }, amountSat: 50 });
  await assert.rejects(new L402Payer({ lnd: agentLnd(), maxAmountSat: 10 }).payChallenge(ch), /above limit/);
});

test('regtest: HTTP 402 → pay → 200; tampered credential → 401; reuse → 200', { skip }, async () => {
  const mint = new Mint({ challenger: new LndChallenger(serverLnd()) });
  const guard = createL402Guard({ mint, service: 'premium', priceSat: 3 });
  const server = createServer((req, res) => {
    void guard(req, res, () => { res.statusCode = 200; res.end('secret data'); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}/premium`;

  try {
    const r1 = await fetch(url);
    assert.equal(r1.status, 402);
    const challenges = r1.headers.get('www-authenticate')!;
    // Node's fetch joins multiple WWW-Authenticate values with ", "; take the L402 one.
    const l402Header = challenges.split(/,\s*(?=(?:LSAT|L402)\s)/).find((h) => h.startsWith('L402'))!;
    const challenge = parseChallenge(l402Header);

    const paid = await new L402Payer({ lnd: agentLnd(), maxAmountSat: 10 }).payChallenge(challenge);
    const auth = formatCredential(paid.credential);

    const r2 = await fetch(url, { headers: { Authorization: auth } });
    assert.equal(r2.status, 200);
    assert.equal(await r2.text(), 'secret data');

    // tamper: flip the last hex char of the preimage
    const bad = auth.slice(0, -1) + (auth.endsWith('0') ? '1' : '0');
    const r3 = await fetch(url, { headers: { Authorization: bad } });
    assert.equal(r3.status, 401);
    assert.match(await r3.text(), /invalid_preimage/);

    // credentials are reusable (spec §8) until revoked
    const r4 = await fetch(url, { headers: { Authorization: auth } });
    assert.equal(r4.status, 200);

    await mint.revoke(parseCredential(auth).macaroon);
    const r5 = await fetch(url, { headers: { Authorization: auth } });
    assert.equal(r5.status, 401);
    assert.match(await r5.text(), /unknown_macaroon/);
  } finally {
    server.close();
  }
});
