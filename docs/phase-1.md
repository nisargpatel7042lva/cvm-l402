# Phase 1 — L402 primitive, standalone

Date: 2026-09-20. No ContextVM/Nostr involved; real HTTP + real regtest Lightning.

## Sources read (not assumed)

- `lightninglabs/L402` — `protocol-specification.md` (headers, grammar, flows, status codes),
  `macaroon-spec.md` (identifier, HMAC chain, caveats, satisfiers, V2 binary).
- `go-macaroon/macaroon` v2 — `macaroon.go`, `crypto.go`, `marshal-v2.go`, `packet-v2.go`.
- `lightninglabs/aperture` — `l402/identifier.go`, `l402/header.go`, `l402/caveat.go`,
  `mint/mint.go`, `auth/authenticator.go`.

### Discrepancies found (implemented per the reference library, not the spec doc)

| Topic | `macaroon-spec.md` says | `gopkg.in/macaroon.v2` (Aperture) does |
|---|---|---|
| Root key use | `sig0 = HMAC(root_key, id)` | `sig0 = HMAC(HMAC("macaroons-key-generator", root_key), id)` |
| V2 field tags | caveat id `0x01`, vid `0x02`, trailing EOS after signature | location `1`, identifier `2`, vid `4` (omitted if empty), signature `6`; EOS after caveat list, **no** trailing EOS |

Verified byte-for-byte against an independent implementation (`pymacaroons`, libmacaroons-compatible):
see the vector in `src/l402/macaroon.test.ts`.

## What was built (`src/l402/`)

| File | Role |
|---|---|
| `macaroon.ts` | V2 binary encode/decode, HMAC chain, first-party caveats, attenuation, signature verify |
| `identifier.ts` | `uint16BE(0) ‖ payment_hash ‖ token_id` (66 bytes) |
| `caveat.ts` | `condition=value`, `services=` and `<svc>_valid_until=` satisfiers, subset/monotonic rules |
| `header.ts` | `WWW-Authenticate: L402 macaroon="…", invoice="…"`, `Authorization: L402 <b64>:<hex>`; LSAT accepted |
| `mint.ts` | `Mint.mint()` (invoice → identifier → root key by `sha256(id)` → caveated macaroon), `Mint.verify()` (preimage ⇒ signature ⇒ caveats), revoke |
| `lnd-rest.ts` | Zero-dep LND REST client (addInvoice, lookupInvoice, decodePayReq, sendPaymentSync) + `LndChallenger` |
| `payer.ts` | Client: amount cap (spec §9.5), macaroon↔invoice hash check, pay, build credential |
| `http-guard.ts` | `node:http` middleware: 402 challenge / 401 on bad credential / pass-through on success |

## Tests

- `npm test` → 32 tests: 29 unit (pure logic, always run) + 3 regtest integration
  (auto-skipped when `infra/creds` is absent).
- `npm run demo:l402` → gate script; prints the whole loop.

## Known limitations / choices

- Demo HTTP server is plain `http://127.0.0.1` (spec mandates TLS in production).
- `MemorySecretStore` only; `SecretStore` is an interface for a persistent backend.
- `sendPaymentSync` (`/v1/channels/transactions`) is deprecated in LND in favour of router RPC;
  it works on 0.19 and keeps the client dependency-free. Swap for `/v2/router/send` later if needed.
- Only first-party caveats (as L402 specifies); third-party caveats are rejected on decode.
