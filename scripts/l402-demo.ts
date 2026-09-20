/**
 * Phase 1 gate: full L402 round trip over real HTTP + regtest Lightning.
 *
 *   agent  ── GET /premium ──────────────────────▶ server   402 + WWW-Authenticate: L402 macaroon=…, invoice=…
 *   agent  ── pay invoice (lnd-agent → lnd-server) ▶ LN      preimage
 *   agent  ── GET /premium  Authorization: L402 mac:preimage ▶ server   verify sha256(preimage)==H, HMAC chain, caveats → 200
 */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { agentLnd, devCredsAvailable, serverLnd } from '../src/l402/dev-nodes.js';
import { LndChallenger } from '../src/l402/lnd-rest.js';
import { Mint } from '../src/l402/mint.js';
import { createL402Guard } from '../src/l402/http-guard.js';
import { L402Payer } from '../src/l402/payer.js';
import { formatCredential, parseChallenge } from '../src/l402/header.js';
import { decodeIdentifier } from '../src/l402/identifier.js';
import { sha256, toHex } from '../src/l402/bytes.js';

if (!devCredsAvailable()) {
  console.error('infra/creds not found — run: ./infra/setup-ln.sh');
  process.exit(1);
}

const PRICE_SAT = 21;
const step = (n: number, s: string) => console.log(`\n[${n}] ${s}`);
const kv = (k: string, v: string) => console.log(`      ${k.padEnd(14)} ${v}`);
const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s);

// ── server ───────────────────────────────────────────────────────────────────
const mint = new Mint({ challenger: new LndChallenger(serverLnd()) });
const guard = createL402Guard({
  mint,
  service: 'premium',
  priceSat: PRICE_SAT,
  validForSeconds: 3600,
  onEvent: (e) => {
    if (e.type === 'challenge') kv('server', `minted macaroon for payment_hash ${short(e.paymentHashHex, 16)}, price ${e.priceSat} sat`);
    if (e.type === 'accepted') kv('server', `credential OK for payment_hash ${short(e.paymentHashHex, 16)} → serving resource`);
    if (e.type === 'rejected') kv('server', `credential REJECTED (${e.reason})`);
  },
});
const server = createServer((req, res) => {
  void guard(req, res, () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ secret: 'the premium payload', served_at: new Date().toISOString() }));
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/premium`;
console.log(`L402 demo — server at ${url}, price ${PRICE_SAT} sat`);

const [srvInfo, agtInfo] = await Promise.all([serverLnd().getInfo(), agentLnd().getInfo()]);
kv('server node', `${srvInfo.alias} ${short(srvInfo.identity_pubkey, 20)}`);
kv('agent node', `${agtInfo.alias} ${short(agtInfo.identity_pubkey, 20)}`);

// ── agent ────────────────────────────────────────────────────────────────────
step(1, 'agent requests the priced resource with no credential');
const r1 = await fetch(url);
kv('status', `${r1.status} ${r1.statusText}`);
const wwwAuth = r1.headers.get('www-authenticate') ?? '';
const l402Header = wwwAuth.split(/,\s*(?=(?:LSAT|L402)\s)/).find((h) => h.startsWith('L402'))!;
kv('WWW-Auth', short(l402Header, 90));
const challenge = parseChallenge(l402Header);
const id = decodeIdentifier(challenge.macaroon.identifier);
kv('macaroon', `location=${challenge.macaroon.location} caveats=${JSON.stringify(challenge.macaroon.caveats)}`);
kv('payment_hash', toHex(id.paymentHash));
kv('invoice', short(challenge.invoice, 60));

step(2, 'agent checks the invoice against its own node and pays it');
const payer = new L402Payer({ lnd: agentLnd(), maxAmountSat: 100 });
const t0 = Date.now();
const paid = await payer.payChallenge(challenge);
kv('paid', `${paid.amountSat} sat (+${paid.feeSat} sat fee) in ${Date.now() - t0} ms`);
kv('preimage', toHex(paid.credential.preimage));
kv('sha256(pre)', `${toHex(sha256(paid.credential.preimage))}  ${toHex(sha256(paid.credential.preimage)) === toHex(id.paymentHash) ? '== payment_hash ✔' : '!= payment_hash ✘'}`);

step(3, 'agent retries with Authorization: L402 <macaroon>:<preimage>');
const auth = formatCredential(paid.credential);
kv('Authorization', short(auth, 90));
const r2 = await fetch(url, { headers: { Authorization: auth } });
kv('status', `${r2.status} ${r2.statusText}`);
kv('body', await r2.text());

step(4, 'negative check: same macaroon, wrong preimage');
const wrong = formatCredential({ macaroon: paid.credential.macaroon, preimage: new Uint8Array(32) });
const r3 = await fetch(url, { headers: { Authorization: wrong } });
kv('status', `${r3.status} ${r3.statusText}`);
kv('body', await r3.text());

step(5, 'credential reuse (no second payment) → still 200');
const r4 = await fetch(url, { headers: { Authorization: auth } });
kv('status', `${r4.status} ${r4.statusText}`);

const inv = await serverLnd().lookupInvoice(id.paymentHash);
console.log(`\nserver node invoice state: ${inv.state}, amt_paid_sat=${inv.amtPaidSat}`);
console.log(r2.status === 200 && r3.status === 401 && r4.status === 200 ? '\nRESULT: L402 round trip OK' : '\nRESULT: FAILED');
server.close();
