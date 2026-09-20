# Phase 0 — gap validation + environment

Date: 2026-09-20

## Gap: does an L402 rail exist in ContextVM?

**No.** Checked on 2026-09-20:

- `ContextVM/sdk` (TS) `src/payments/`: rails are `handlers/ln-bolt11-nwc`, `handlers/ln-bolt11-lnbits`,
  `processors/ln-bolt11-nwc`, `processors/ln-bolt11-lnbits`, `processors/ln-bolt11-zap`. All share
  PMI `bitcoin-lightning-bolt11`. No `l402`/`macaroon` string anywhere in the repo.
- `ContextVM/rs-sdk`: CEP-8 lifecycle implemented (Sep 2026), but "payment rails ship as pluggable
  traits with deterministic fakes; real rails are a later phase". No L402.
- `ContextVM/contextvm-docs` (CEP-8, CEP-21, how-to/payments): only rail doc is `rails/lightning-nwc.md`.
  CEP-21's recommended-PMI table has one row: `bitcoin-lightning-bolt11`.
- GitHub org-wide code search (`l402`, `macaroon`): 0 hits. Issues/PRs mentioning L402: 0.
- Open PRs on `sdk` (as of today): #101, #99, #78 (CEP-47 redirect) — none payments-related.
- Latest `sdk` commit: 2026-09-20 (relay liveness probe); latest payments commit: 2026-09-17 (#96,
  cancel in-flight verification on close). `@contextvm/sdk@0.14.0` published 2026-09-20.

## Extension points (authoritative, from source)

- Server: `PaymentProcessor { pmi; createPaymentRequired(); verifyPayment() }` (`src/payments/types.ts`)
- Client: `PaymentHandler { pmi; canHandle?(); handle() }`
- Wiring: `withServerPayments(transport, { processors, pricedCapabilities })` /
  `withClientPayments(transport, { handlers })`; the Gateway forwards `payments` options verbatim.
- PMI is the "content-type" of `pay_req`; `_meta` is the PMI-specific extension point on
  `payment_required` / payment options / `payment_accepted`.
- Explicit gating: `-32042 Payment Required` → client pays → retries same `method`+`params`;
  server matches on `sha256(JCS({method, params minus _meta}))` + client pubkey. `params._meta`
  is explicitly excluded from the identity — a natural carrier for L402 proof on retry.

## Environment

- Node v24.10.0, npm 11.6.1, TypeScript, `tsx`, `node --test`.
- Docker: bitcoind 27.0 + 2× LND 0.19.3 (Polar images) + nostr-rs-relay 0.10.0.
- Channel agent→server: 10M sat, 2M pushed. Verified a 21-sat REST payment: agent got preimage,
  server invoice state `SETTLED`.
- ContextVM hello-world: `McpServer` → `InMemoryTransport` → `NostrMCPGateway` → relay →
  `NostrClientTransport` → `Client`. `tools/list` and `tools/call hello` succeed.
