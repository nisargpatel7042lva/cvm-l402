# Phase 2 — CEP-8 payment flow with a stub rail

Date: 2026-09-20. Real local relay + ContextVM SDK payments middleware; no real money.

## Spec re-read (from `ContextVM/contextvm-docs` source, not memory)

- `notifications/payment_required`, `payment_accepted`, `payment_rejected` are all defined in **CEP-8**.
  **CEP-21** only recommends PMI names (`bitcoin-lightning-bolt11`) and naming conventions; it defines
  no messages.
- Required fields — `payment_required`: `amount`, `pay_req`, `pmi` (+ optional `description`, `ttl`, `_meta`);
  `payment_accepted`: `amount`, `pmi` (+ `_meta`); `payment_rejected`: `pmi` (+ `amount`, `message`).
- Transparent notifications MUST carry an `e` tag to the request event; explicit gating uses
  `-32042 Payment Required` / `-32043 Payment Pending` errors and canonical-identity retry matching.

## What was built (`src/cep8/`)

| File | Role |
|---|---|
| `stub-rail.ts` | PMI `stub-v1`: `StubPaymentProcessor` (issue + verify against a shared ledger) and `StubPaymentHandler` (`pay` / `pay-wrong-proof` / `decline`) — fully deterministic |
| `harness.ts` | `startPaidServer()` (McpServer → `NostrMCPGateway` with `paymentOptions`, free `hello` + priced `premium_echo` @ 21 sats) and `startPayingClient()` (`withClientPayments` + a tap recording every inbound JSON-RPC message) |
| `flow.test.ts` | 8 integration tests over the relay |
| `scripts/cep8-demo.ts` | Gate script: 4 scenarios, readable |

## Tests (`npm run test:cep8`) — all pass

1. Free tool untouched by the middleware.
2. Discovery: `pmi` + `payment_interaction=explicit_gating` tags on initialize; `["cap","tool:premium_echo","21","sats"]` on tools/list.
3. Transparent happy path: exact `payment_required` shape (amount/pay_req/pmi/description/ttl/_meta), handler pays, exact `payment_accepted` shape (incl. processor `_meta`), result; order required → accepted → result.
4. `resolvePrice` → `rejectPrice()` emits `payment_rejected` `{pmi, amount, message}`; client's promise rejects immediately; no invoice minted.
5. **Wrong proof:** `verifyPayment` throws → server drops the request; **no** `payment_rejected`; client times out.
6. Client `canHandle=false` → local decline, nothing paid.
7. Explicit gating: raw `-32042` with `payment_options[]` + instructions on the wire → `onPaymentRequired` → pay → SDK retries → result; no transparent notifications.
8. Explicit gating decline → error surfaced, nothing paid.

## Findings that affect Phase 3 (L402)

1. **Verification failure is silent in the SDK's transparent path.** A thrown `verifyPayment` (bad proof,
   timeout) yields no `payment_rejected` — only `resolvePrice` rejections and capacity refusals emit it.
   CEP-8 permits this (MAY), but an L402 rail that checks `sha256(preimage)` has a definite "bad proof"
   moment and should tell the agent. Plan: emit `payment_rejected` from the L402 middleware on proof failure.
2. **Same-second retry dedup.** An explicit-gating retry that re-publishes the identical request within the
   same second produces the same Nostr event id and is dropped by the relay (the SDK's own tests sleep
   past the boundary). Option B for L402 (credential in `params._meta` on retry) changes the content and
   therefore the event id, so it is immune; option A would need a delay guard.
3. `PaymentProcessor.verifyPayment` only receives `pay_req`, `requestEventId`, `clientPubkey` — it cannot
   see the retry's proof. A stateless L402 verify therefore needs an inbound middleware in front of the
   SDK's gating (it can still delegate invoice minting to a `PaymentProcessor`).
