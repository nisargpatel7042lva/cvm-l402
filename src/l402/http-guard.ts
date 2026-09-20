/**
 * Framework-free L402 guard for node:http (protocol-specification.md §4.1, §6.1):
 *   no credential            → 402 + WWW-Authenticate challenge (LSAT first, then L402, like Aperture)
 *   credential fails verify  → 401
 *   credential ok            → handler runs
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { formatChallenge, parseCredential, LEGACY_SCHEME, SCHEME } from './header.js';
import { L402VerifyError, type Mint } from './mint.js';

export interface GuardOptions {
  mint: Mint;
  service: string;
  priceSat: number;
  validForSeconds?: number;
  onEvent?: (e: GuardEvent) => void;
}

export type GuardEvent =
  | { type: 'challenge'; paymentHashHex: string; priceSat: number }
  | { type: 'accepted'; paymentHashHex: string }
  | { type: 'rejected'; reason: string };

export function createL402Guard(opts: GuardOptions) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void | Promise<void>): Promise<void> => {
    const auth = req.headers.authorization;
    if (!auth) {
      const { macaroon, invoice, paymentHash } = await opts.mint.mint({
        service: { name: opts.service, tier: 0 },
        amountSat: opts.priceSat,
        memo: `L402 ${opts.service}`,
        validForSeconds: opts.validForSeconds,
      });
      const ch = { macaroon, invoice };
      opts.onEvent?.({ type: 'challenge', paymentHashHex: Buffer.from(paymentHash).toString('hex'), priceSat: opts.priceSat });
      res.statusCode = 402;
      res.setHeader('WWW-Authenticate', [formatChallenge(ch, LEGACY_SCHEME), formatChallenge(ch, SCHEME)]);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'payment required', price_sat: opts.priceSat }));
      return;
    }

    try {
      const cred = parseCredential(auth);
      const id = await opts.mint.verify({ macaroon: cred.macaroon, preimage: cred.preimage, targetService: opts.service });
      opts.onEvent?.({ type: 'accepted', paymentHashHex: Buffer.from(id.paymentHash).toString('hex') });
      await next();
    } catch (e) {
      const reason = e instanceof L402VerifyError ? `${e.reason}: ${e.message}` : `malformed: ${(e as Error).message}`;
      opts.onEvent?.({ type: 'rejected', reason });
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized', reason }));
    }
  };
}
