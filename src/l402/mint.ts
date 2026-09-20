/**
 * L402 minter/verifier (aperture `mint/mint.go`).
 *
 * Minting:   invoice from the Challenger → identifier(paymentHash, random tokenId)
 *            → fresh 32-byte root key stored under sha256(identifier)
 *            → macaroon(location "lsat") + `services=` (+ `<svc>_valid_until=`) caveats.
 * Verifying: sha256(preimage) == identifier.paymentHash  (stateless payment proof)
 *            → HMAC chain against the stored root key       (integrity / not revoked)
 *            → caveat satisfiers for the target service.
 */
import { bytesEqual, random32, sha256, toHex } from './bytes.js';
import { COND_SERVICES, decodeCaveat, encodeCaveat, encodeServices, servicesSatisfier, timeoutSatisfier, validUntilCondition, verifyCaveats, type Caveat, type Service } from './caveat.js';
import { decodeIdentifier, encodeIdentifier, newIdentifier } from './identifier.js';
import { Macaroon } from './macaroon.js';

export const MACAROON_LOCATION = 'lsat';

/** Creates a BOLT11 invoice for `amountSat` and returns it with its payment hash. */
export interface Challenger {
  newChallenge(amountSat: number, memo?: string): Promise<{ invoice: string; paymentHash: Uint8Array }>;
}

/** Root-key storage keyed by hex(sha256(identifier)). Deleting a key revokes the macaroon. */
export interface SecretStore {
  put(idHash: string, rootKey: Uint8Array): Promise<void>;
  get(idHash: string): Promise<Uint8Array | undefined>;
  revoke(idHash: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  private readonly keys = new Map<string, Uint8Array>();
  async put(idHash: string, rootKey: Uint8Array): Promise<void> { this.keys.set(idHash, rootKey); }
  async get(idHash: string): Promise<Uint8Array | undefined> { return this.keys.get(idHash); }
  async revoke(idHash: string): Promise<void> { this.keys.delete(idHash); }
  get size(): number { return this.keys.size; }
}

export interface MintOptions {
  challenger: Challenger;
  secrets?: SecretStore;
  now?: () => number; // unix seconds
}

export interface MintRequest {
  service: Service;
  amountSat: number;
  memo?: string;
  /** Optional expiry as a `<service>_valid_until` caveat (seconds from now). */
  validForSeconds?: number;
}

export class L402VerifyError extends Error {
  constructor(public readonly reason: 'invalid_preimage' | 'unknown_macaroon' | 'bad_signature' | 'caveat' | 'malformed', message: string) {
    super(message);
  }
}

export const idHashOf = (identifier: Uint8Array): string => toHex(sha256(identifier));

export class Mint {
  private readonly challenger: Challenger;
  private readonly secrets: SecretStore;
  private readonly now: () => number;

  constructor(opts: MintOptions) {
    this.challenger = opts.challenger;
    this.secrets = opts.secrets ?? new MemorySecretStore();
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async mint(req: MintRequest): Promise<{ macaroon: Macaroon; invoice: string; paymentHash: Uint8Array }> {
    const { invoice, paymentHash } = await this.challenger.newChallenge(req.amountSat, req.memo);
    const identifier = encodeIdentifier(newIdentifier(paymentHash));
    const rootKey = random32();
    const idHash = idHashOf(identifier);
    await this.secrets.put(idHash, rootKey);

    const macaroon = Macaroon.create(rootKey, identifier, MACAROON_LOCATION);
    const caveats: Caveat[] = [{ condition: COND_SERVICES, value: encodeServices([req.service]) }];
    if (req.validForSeconds !== undefined) {
      caveats.push({ condition: validUntilCondition(req.service.name), value: String(this.now() + req.validForSeconds) });
    }
    for (const c of caveats) macaroon.addFirstPartyCaveat(encodeCaveat(c));
    return { macaroon, invoice, paymentHash };
  }

  /** Throws L402VerifyError on any failure; resolves with the decoded identifier on success. */
  async verify(params: { macaroon: Macaroon; preimage: Uint8Array; targetService: string }) {
    const { macaroon, preimage, targetService } = params;
    let id;
    try { id = decodeIdentifier(macaroon.identifier); }
    catch (e) { throw new L402VerifyError('malformed', (e as Error).message); }

    if (preimage.length !== 32 || !bytesEqual(sha256(preimage), id.paymentHash)) {
      throw new L402VerifyError('invalid_preimage', 'preimage does not hash to the macaroon payment hash');
    }
    const rootKey = await this.secrets.get(idHashOf(macaroon.identifier));
    if (!rootKey) throw new L402VerifyError('unknown_macaroon', 'macaroon was not minted here or has been revoked');
    if (!macaroon.verifySignature(rootKey)) throw new L402VerifyError('bad_signature', 'macaroon signature mismatch');

    const caveats = macaroon.caveats.map(decodeCaveat).filter((c): c is Caveat => c !== undefined);
    try {
      verifyCaveats(caveats, [servicesSatisfier(targetService), timeoutSatisfier(targetService, this.now)]);
    } catch (e) { throw new L402VerifyError('caveat', (e as Error).message); }
    return id;
  }

  revoke(macaroon: Macaroon): Promise<void> {
    return this.secrets.revoke(idHashOf(macaroon.identifier));
  }
}
