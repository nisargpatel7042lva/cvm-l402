/**
 * Client side of L402 (protocol-specification.md §6.2): given a challenge,
 * sanity-check the invoice, pay it over Lightning, and build the credential.
 */
import { bytesEqual } from './bytes.js';
import { parseChallenge, type L402Challenge, type L402Credential } from './header.js';
import { decodeIdentifier } from './identifier.js';
import type { LndRestClient } from './lnd-rest.js';

export interface PayerOptions {
  lnd: LndRestClient;
  /** Refuse to pay invoices above this amount (spec §9.5: MUST enforce a threshold). */
  maxAmountSat: number;
  feeLimitSat?: number;
}

export interface PaidChallenge { credential: L402Credential; amountSat: number; feeSat: number }

export class L402Payer {
  constructor(private readonly opts: PayerOptions) {}

  async payChallenge(challenge: L402Challenge | string): Promise<PaidChallenge> {
    const ch = typeof challenge === 'string' ? parseChallenge(challenge) : challenge;

    // Decode with our own node: amount check + confirm the macaroon commits to *this* invoice.
    const decoded = await this.opts.lnd.decodePayReq(ch.invoice);
    if (decoded.numSatoshis > this.opts.maxAmountSat) {
      throw new Error(`invoice asks ${decoded.numSatoshis} sat, above limit ${this.opts.maxAmountSat} sat`);
    }
    const id = decodeIdentifier(ch.macaroon.identifier);
    if (!bytesEqual(id.paymentHash, decoded.paymentHash)) {
      throw new Error('macaroon payment hash does not match invoice payment hash');
    }

    const paid = await this.opts.lnd.payInvoice(ch.invoice, { feeLimitSat: this.opts.feeLimitSat });
    return { credential: { macaroon: ch.macaroon, preimage: paid.preimage }, amountSat: decoded.numSatoshis, feeSat: paid.feeSat };
  }
}
