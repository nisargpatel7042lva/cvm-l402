/**
 * Phase 2 gate: CEP-8 payment flow over the local Nostr relay with the stub
 * rail (no real money). Shows both lifecycles and both outcomes.
 */
import { PAYMENT_ACCEPTED_METHOD, PAYMENT_REJECTED_METHOD, PAYMENT_REQUIRED_METHOD, rejectPrice } from '@contextvm/sdk/payments';
import { PMI_STUB, StubLedger, StubPaymentHandler, StubPaymentProcessor } from '../src/cep8/stub-rail.js';
import { RELAY_URL, startPaidServer, startPayingClient } from '../src/cep8/harness.js';

const step = (s: string) => console.log(`\n── ${s}`);
const line = (k: string, v: unknown) => console.log(`   ${k.padEnd(20)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const sleepPastSecond = () => new Promise<void>((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 10));

console.log(`CEP-8 demo — relay ${RELAY_URL}, rail ${PMI_STUB}`);

step('A. transparent lifecycle, agent pays automatically');
{
  const ledger = new StubLedger();
  const server = await startPaidServer({ processors: [new StubPaymentProcessor(ledger, { ttlSeconds: 120 })] });
  line('server pubkey', server.pubkey);
  const c = await startPayingClient(server.pubkey, { handlers: [new StubPaymentHandler(ledger, 'pay')] });
  const init = c.base.getServerInitializeEvent()!;
  line('server pmi tags', init.tags.filter((t) => t[0] === 'pmi'));
  await c.client.listTools();
  line('tools/list cap tags', c.base.getServerToolsListEvent()!.tags.filter((t) => t[0] === 'cap'));

  const free = await c.client.callTool({ name: 'hello', arguments: { name: 'agent' } });
  line('hello (free) →', (free as { content: { text: string }[] }).content[0]!.text);

  const t0 = Date.now();
  const paid = await c.client.callTool({ name: 'premium_echo', arguments: { text: 'pay me' } });
  line(PAYMENT_REQUIRED_METHOD, c.notifications(PAYMENT_REQUIRED_METHOD)[0]?.params);
  line('handler paid', Object.fromEntries(ledger.submitted));
  line(PAYMENT_ACCEPTED_METHOD, c.notifications(PAYMENT_ACCEPTED_METHOD)[0]?.params);
  line('premium_echo →', `${(paid as { content: { text: string }[] }).content[0]!.text}  (${Date.now() - t0} ms)`);
  await c.stop(); await server.stop();
}

step('B. transparent lifecycle, server policy rejects → payment_rejected');
{
  const ledger = new StubLedger();
  const server = await startPaidServer({ processors: [new StubPaymentProcessor(ledger)], resolvePrice: async () => rejectPrice('agent not on allowlist') });
  const c = await startPayingClient(server.pubkey, { handlers: [new StubPaymentHandler(ledger, 'pay')] });
  try { await c.client.callTool({ name: 'premium_echo', arguments: { text: 'x' } }); }
  catch (e) { line('callTool threw', (e as Error).message); }
  line(PAYMENT_REJECTED_METHOD, c.notifications(PAYMENT_REJECTED_METHOD)[0]?.params);
  await c.stop(); await server.stop();
}

step('C. explicit_gating lifecycle, agent sees -32042, decides, pays, retries');
{
  const ledger = new StubLedger();
  const server = await startPaidServer({ processors: [new StubPaymentProcessor(ledger, { ttlSeconds: 60 })] });
  const c = await startPayingClient(server.pubkey, {
    paymentInteraction: 'explicit_gating',
    onPaymentRequired: async ({ options, instructions }) => {
      line('-32042 options', options);
      line('-32042 instructions', instructions);
      const opt = options[0]!;
      ledger.submit(opt.pay_req, ledger.expected.get(opt.pay_req)!.proof);
      line('agent decision', `pay ${opt.amount} via ${opt.pmi}`);
      await sleepPastSecond(); // retry must not collide with the original event id (same second)
      return { paid: true };
    },
  });
  line('effective mode', c.base.getEffectivePaymentInteraction());
  const r = await c.client.callTool({ name: 'premium_echo', arguments: { text: 'gated' } });
  line('premium_echo →', (r as { content: { text: string }[] }).content[0]!.text);
  await c.stop(); await server.stop();
}

step('D. transparent lifecycle, agent submits a WRONG proof');
{
  const ledger = new StubLedger();
  const proc = new StubPaymentProcessor(ledger, { ttlSeconds: 2 });
  const server = await startPaidServer({ processors: [proc], paymentTtlMs: 2000 });
  const c = await startPayingClient(server.pubkey, { handlers: [new StubPaymentHandler(ledger, 'pay-wrong-proof')] });
  try { await c.client.callTool({ name: 'premium_echo', arguments: { text: 'x' } }, undefined, { timeout: 4000, resetTimeoutOnProgress: false }); }
  catch (e) { line('callTool threw', (e as Error).message); }
  line('server verify log', proc.verified);
  line('notifications seen', [PAYMENT_REQUIRED_METHOD, PAYMENT_ACCEPTED_METHOD, PAYMENT_REJECTED_METHOD].map((m) => `${m.split('/')[1]}=${c.notifications(m).length}`).join(' '));
  line('note', 'SDK drops the request on verify failure; no payment_rejected is emitted (CEP-8 says MAY)');
  await c.stop(); await server.stop();
}

console.log('\nRESULT: CEP-8 flow OK');
process.exit(0);
