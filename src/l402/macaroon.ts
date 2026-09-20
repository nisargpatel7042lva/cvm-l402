/**
 * Minimal macaroon implementation, wire-compatible with gopkg.in/macaroon.v2
 * (the library Aperture uses) for the subset L402 needs: V2 binary format and
 * first-party caveats only.
 *
 * Signature chain (from macaroon.v2 `New`/`addCaveat`/`crypto.go`):
 *   derived = HMAC(key="macaroons-key-generator", rootKey)
 *   sig     = HMAC(derived, identifier)
 *   sig     = HMAC(sig, caveatId)   for each first-party caveat, in order
 *
 * Note: the L402 repo's macaroon-spec.md omits the "macaroons-key-generator"
 * derivation and lists different V2 field tags; the library is authoritative.
 */
import { bytesEqual, concat, fromUtf8, hmacSha256, utf8 } from './bytes.js';

const KEY_GEN = utf8('macaroons-key-generator');

// V2 field tags (macaroon.v2 packet-v2.go).
const F_EOS = 0;
const F_LOCATION = 1;
const F_IDENTIFIER = 2;
const F_VERIFICATION_ID = 4;
const F_SIGNATURE = 6;
const V2 = 2;

function makeKey(rootKey: Uint8Array): Uint8Array {
  return hmacSha256(KEY_GEN, rootKey);
}

function encodeVarint(n: number): Uint8Array {
  const out: number[] = [];
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return new Uint8Array(out);
}

function packet(tag: number, data: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), encodeVarint(data.length), data);
}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get done(): boolean { return this.pos >= this.buf.length; }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('macaroon: unexpected end of data');
    return this.buf[this.pos++]!;
  }
  varint(): number {
    let n = 0, shift = 0;
    for (;;) {
      const b = this.byte();
      n |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return n >>> 0;
      shift += 7;
      if (shift > 28) throw new Error('macaroon: varint too large');
    }
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('macaroon: unexpected end of data');
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** Reads one packet: returns [tag, data]; EOS has empty data. */
  packet(): [number, Uint8Array] {
    const tag = this.byte();
    if (tag === F_EOS) return [tag, new Uint8Array()];
    return [tag, this.bytes(this.varint())];
  }
}

export class Macaroon {
  private constructor(
    public readonly location: string,
    public readonly identifier: Uint8Array,
    private readonly _caveats: string[],
    private _signature: Uint8Array,
  ) {}

  /** Mint a fresh macaroon (no caveats yet) bound to `identifier` under `rootKey`. */
  static create(rootKey: Uint8Array, identifier: Uint8Array, location: string): Macaroon {
    const sig = hmacSha256(makeKey(rootKey), identifier);
    return new Macaroon(location, identifier, [], sig);
  }

  get caveats(): readonly string[] { return this._caveats; }
  get signature(): Uint8Array { return this._signature; }

  /** Appends a first-party caveat and extends the HMAC chain. Anyone holding the macaroon can do this. */
  addFirstPartyCaveat(condition: string): this {
    this._caveats.push(condition);
    this._signature = hmacSha256(this._signature, utf8(condition));
    return this;
  }

  /** Recomputes the chain from `rootKey` and constant-time compares with the stored signature. */
  verifySignature(rootKey: Uint8Array): boolean {
    let sig = hmacSha256(makeKey(rootKey), this.identifier);
    for (const c of this._caveats) sig = hmacSha256(sig, utf8(c));
    return bytesEqual(sig, this._signature);
  }

  /** V2 binary serialization (macaroon.v2 `appendBinaryV2`). */
  serialize(): Uint8Array {
    const parts: Uint8Array[] = [new Uint8Array([V2])];
    if (this.location.length > 0) parts.push(packet(F_LOCATION, utf8(this.location)));
    parts.push(packet(F_IDENTIFIER, this.identifier), new Uint8Array([F_EOS]));
    for (const c of this._caveats) {
      parts.push(packet(F_IDENTIFIER, utf8(c)), new Uint8Array([F_EOS]));
    }
    parts.push(new Uint8Array([F_EOS]), packet(F_SIGNATURE, this._signature));
    return concat(...parts);
  }

  static deserialize(bytes: Uint8Array): Macaroon {
    const r = new Reader(bytes);
    if (r.byte() !== V2) throw new Error('macaroon: unsupported version (only V2 binary supported)');

    // Header section: optional location, identifier, EOS.
    let location = '';
    let [tag, data] = r.packet();
    if (tag === F_LOCATION) { location = fromUtf8(data); [tag, data] = r.packet(); }
    if (tag !== F_IDENTIFIER) throw new Error('macaroon: expected identifier');
    const identifier = data;
    if (r.packet()[0] !== F_EOS) throw new Error('macaroon: expected end of header');

    // Caveat sections until a bare EOS.
    const caveats: string[] = [];
    for (;;) {
      [tag, data] = r.packet();
      if (tag === F_EOS) break;
      if (tag === F_LOCATION) [tag, data] = r.packet(); // caveat location: ignored
      if (tag !== F_IDENTIFIER) throw new Error('macaroon: expected caveat identifier');
      const caveatId = data;
      [tag, data] = r.packet();
      if (tag === F_VERIFICATION_ID) {
        if (data.length > 0) throw new Error('macaroon: third-party caveats are not supported');
        [tag, data] = r.packet();
      }
      if (tag !== F_EOS) throw new Error('macaroon: expected end of caveat');
      caveats.push(fromUtf8(caveatId));
    }

    [tag, data] = r.packet();
    if (tag !== F_SIGNATURE) throw new Error('macaroon: expected signature');
    if (data.length !== 32) throw new Error('macaroon: signature must be 32 bytes');
    if (!r.done) throw new Error('macaroon: trailing data');
    return new Macaroon(location, identifier, caveats, data);
  }
}
