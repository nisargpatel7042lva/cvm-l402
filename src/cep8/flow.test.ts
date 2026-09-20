/**
 * CEP-8 payment flow over the real local relay with the stub rail.
 * Integration: skipped when the relay at RELAY_URL is not reachable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { rejectPrice, PAYMENT_REQUIRED_METHOD, PAYMENT_ACCEPTED_METHOD, PAYMENT_REJECTED_METHOD, PAYMENT_REQUIRED_ERROR_CODE } from '@contextvm/sdk/payments';
import { PMI_STUB, StubLedger, StubPaymentHandler, StubPaymentProcessor } from './stub-rail.js';
import { PREMIUM_PRICE_SAT, RELAY_URL, startPaidServer, startPayingClient } from './harness.js';

// node:test evaluates `skip` at registration, so probe the relay synchronously-ish up front.
const relayDown: boolean | string = await new Promise<boolean | string>((res) => {
  const ws = new WebSocket(RELAY_URL);
  ws.once('open', () => { ws.close(); res(false); });
  ws.once('error', () => res(`relay ${RELAY_URL} not reachable`));
});

/**
 * A retry republished within the same second as the original has an identical
 * Nostr event id (content + author + created_at + tags) and is deduplicated by
 * the relay. The SDK's own tests wait past the boundary for instant-pay cases.
 */
const sleepPastSecondBoundary = () => new Promise<void>((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 10));

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

test('free tool is unaffected by payments middleware', { skip: relayDown }, async () => {
  const ledger = new StubLedger();
  const server = await startPaidServer({ processors: [new StubPaymentProcessor(ledger)] });
  const c = await startPayingClient(server.pubkey, { handlers: [new StubPaymentHandler(ledger)] });
  try {
    assert.equal(text(await c.client.callTool({ name: 'hello', arguments: { name: 'x' } })), 'hello, x');
    assert.equal(c.notifications(PAYMENT_REQUIRED_METHOD).length, 0);
  } finally { await c.stop(); await server.stop(); }
});

test('discovery: cap + pmi tags advertised on initialize and tools/list responses', { skip: relayDown }, async () => {
  const ledger = new StubLedger();
  const server = await startPaidServer({ processors: [new StubPaymentProcessor(ledger)] });
  const c = await startPayingClient(server.pubkey, { handlers: [new StubPaymentHandler(ledger)] });
  try {
    await c.client.listTools();
    const init = c.base.getServerInitializeEvent()!;
    assert.ok(init.tags.some((t) => t[0] === 'pmi' && t[1] === PMI_STUB), 'pmi tag on initialize response');
    assert.ok(init.tags.some((t) => t[0] === 'payment_interaction' && t[1] === 'explicit_gating'), 'explicit_gating advertised');
    const list = c.base.getServerToolsListEvent()!;
    const cap = list.tags.find((t) => t[0] === 'cap');
    assert.deepEqual(cap, ['cap', 'tool:premium_echo', String(PREMIUM_PRICE_SAT), 'sats']);
  } finally { await c.stop(); await server.stop(); }
});

test('transparent: payment_required → pay → payment_accepted → result (shapes + order)', { skip: relayDown }, async () => {
  const ledger = new StubLedger();
  const processor = new StubPaymentProcessor(ledger, { ttlSeconds: 120 });
  const handler = new StubPaymentHandler(ledger, 'pay');
  const server = await startPaidServer({ processors: [processor] });
  const c = await startPayingClient(server.pubkey, { handlers: [handler] });
  try {
    const result = await c.client.callTool({ name: 'premium_echo', arguments: { text: 'hi' } });
    assert.equal(text(result), 'PREMIUM: hi');

    const [req] = c.notifications(PAYMENT_REQUIRED_METHOD);
    assert.ok(req, 'payment_required received');
    const p = req!.params!;
    assert.equal(p.amount, PREMIUM_PRICE_SAT);
    assert.equal(p.pmi, PMI_STUB);
    assert.match(String(p.pay_req), /^stub:\d+$/);
    assert.equal(p.description, 'premium_echo invocation');
    assert.equal(p.ttl, 120);
    assert.deepEqual(p._meta, { stub: true });

    const [acc] = c.notifications(PAYMENT_ACCEPTED_METHOD);
    assert.ok(acc, 'payment_accepted received');
    assert.equal(acc!.params!.amount, PREMIUM_PRICE_SAT);
    assert.equal(acc!.params!.pmi, PMI_STUB);
    assert.deepEqual(acc!.params!._meta, { stub_proof: ledger.expected.get(String(p.pay_req))!.proof });

    assert.equal(c.notifications(PAYMENT_REJECTED_METHOD).length, 0);
    assert.equal(handler.requests.length, 1);
    assert.equal(handler.requests[0]!.pay_req, p.pay_req);
    assert.deepEqual(processor.verified, [{ payReq: p.pay_req, ok: true }]);

    // ordering: required < accepted < result
    const idx = (m: string) => c.tapped.findIndex((t) => 'method' in t.message && t.message.method === m);
    const resultIdx = c.tapped.findLastIndex((t) => 'result' in t.message); // last: initialize/tools responses come first
    assert.ok(idx(PAYMENT_REQUIRED_METHOD) < idx(PAYMENT_ACCEPTED_METHOD) && idx(PAYMENT_ACCEPTED_METHOD) < resultIdx);
  } finally { await c.stop(); await server.stop(); }
});

test('transparent: resolvePrice rejection → payment_rejected (shape) and the call fails fast', { skip: relayDown }, async () => {
  const ledger = new StubLedger();
  const processor = new StubPaymentProcessor(ledger);
  const server = await startPaidServer({ processors: [processor], resolvePrice: async () => rejectPrice('blocked by policy') });
  const c = await startPayingClient(server.pubkey, { handlers: [new StubPaymentHandler(ledger)] });
  try {
    await assert.rejects(c.client.callTool({ name: 'premium_echo', arguments: { text: 'x' } }), /Payment rejected: blocked by policy/);
    const [rej] = c.notifications(PAYMENT_REJECTED_METHOD);
    assert.ok(rej);
    assert.deepEqual(rej!.params, { pmi: PMI_STUB, amount: PREMIUM_PRICE_SAT, message: 'blocked by policy' });
    assert.equal(c.notifications(PAYMENT_REQUIRED_METHOD).length, 0);
    assert.equal(processor.created.length, 0, 'no invoice minted on policy rejection');
  } finally { await c.stop(); await server.stop(); }
});

test('transparent: wrong proof → verify throws; SDK sends NO payment_rejected, request is dropped (documented behaviour)', { skip: relayDown }, async () => {
  const ledger = new StubLedger();
  const processor = new StubPaymentProcessor(ledger, { ttlSeconds: 2 });
  const server = await startPaidServer({ processors: [processor], paymentTtlMs: 2_000 });
  const c = await startPayingClient(server.pubkey, { handlers: [new StubPaymentHandler(ledger, 'pay-wrong-proof')] });
  try {
    await assert.rejects(c.client.callTool({ name: 'premium_echo', arguments: { text: 'x' } }, undefined, { timeout: 4_000, resetTimeoutOnProgress: false }), /timed out|timeout/i);
    assert.equal(c.notifications(PAYMENT_REQUIRED_METHOD).length, 1);
    assert.equal(c.notifications(PAYMENT_ACCEPTED_METHOD).length, 0);
    assert.equal(c.notifications(PAYMENT_REJECTED_METHOD).length, 0);
    assert.deepEqual(processor.verified, [{ payReq: 'stub:1', ok: false }]);
  } finally { await c.stop(); await server.stop(); }
});

test('transparent: client handler declines → call fails locally, nothing paid', { skip: relayDown }, async () => {
  const ledger = new StubLedger();
  const server = await startPaidServer({ processors: [new StubPaymentProcessor(ledger)], paymentTtlMs: 2_000 });
  const c = await startPayingClient(server.pubkey, { handlers: [new StubPaymentHandler(ledger, 'decline')] });
  try {
    await assert.rejects(c.client.callTool({ name: 'premium_echo', arguments: { text: 'x' } }), /Payment declined by client handler/);
    assert.equal(ledger.submitted.size, 0);
  } finally { await c.stop(); await server.stop(); }
});

test('explicit_gating: -32042 with payment_options → agent pays → retry succeeds', { skip: relayDown }, async () => {
  const ledger = new StubLedger();
  const processor = new StubPaymentProcessor(ledger, { ttlSeconds: 60 });
  const server = await startPaidServer({ processors: [processor] });
  const seen: unknown[] = [];
  const c = await startPayingClient(server.pubkey, {
    paymentInteraction: 'explicit_gating',
    onPaymentRequired: async ({ options, instructions }) => {
      seen.push({ options, instructions });
      const opt = options.find((o) => o.pmi === PMI_STUB)!;
      ledger.submit(opt.pay_req, ledger.expected.get(opt.pay_req)!.proof); // "agent decides to pay"
      await sleepPastSecondBoundary();
      return { paid: true };
    },
  });
  try {
    assert.equal(c.base.getEffectivePaymentInteraction(), 'explicit_gating');
    const result = await c.client.callTool({ name: 'premium_echo', arguments: { text: 'gated' } });
    assert.equal(text(result), 'PREMIUM: gated');

    // raw -32042 error was on the wire
    const err = c.tapped.map((t) => t.message).find((m) => 'error' in m && m.error.code === PAYMENT_REQUIRED_ERROR_CODE) as { error: { message: string; data: { payment_options: Array<Record<string, unknown>>; instructions: string } } };
    assert.ok(err, '-32042 received');
    assert.equal(err.error.message, 'Payment Required');
    assert.equal(err.error.data.payment_options.length, 1);
    const opt = err.error.data.payment_options[0]!;
    assert.equal(opt.amount, PREMIUM_PRICE_SAT);
    assert.equal(opt.pmi, PMI_STUB);
    assert.equal(opt.ttl, 60);
    assert.match(String(opt.pay_req), /^stub:\d+$/);
    assert.match(err.error.data.instructions, /retry the same request/i);

    assert.equal(seen.length, 1);
    assert.equal(c.notifications(PAYMENT_REQUIRED_METHOD).length, 0, 'no transparent notifications in explicit mode');
    assert.deepEqual(processor.verified, [{ payReq: opt.pay_req, ok: true }]);
  } finally { await c.stop(); await server.stop(); }
});

test('explicit_gating: agent declines → -32042 surfaced to caller, nothing paid', { skip: relayDown }, async () => {
  const ledger = new StubLedger();
  const server = await startPaidServer({ processors: [new StubPaymentProcessor(ledger)], paymentTtlMs: 2_000 });
  const c = await startPayingClient(server.pubkey, {
    paymentInteraction: 'explicit_gating',
    onPaymentRequired: async () => ({ paid: false, reason: 'too expensive' }),
  });
  try {
    await assert.rejects(c.client.callTool({ name: 'premium_echo', arguments: { text: 'x' } }), (e: Error) => /too expensive|Payment Required/.test(e.message));
    assert.equal(ledger.submitted.size, 0);
  } finally { await c.stop(); await server.stop(); }
});
