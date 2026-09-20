/**
 * Minimal LND REST client (only what L402 needs). Uses node:https so the
 * node's self-signed TLS cert can be pinned without extra dependencies.
 *
 * Endpoints (LND v0.19 REST):
 *   POST /v1/invoices                 → addInvoice
 *   GET  /v1/invoice/{r_hash_hex}     → lookupInvoice
 *   GET  /v1/payreq/{pay_req}         → decodePayReq
 *   POST /v1/channels/transactions    → sendPaymentSync
 */
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { fromHex, toHex } from './bytes.js';
import type { Challenger } from './mint.js';

export interface LndRestOptions {
  baseUrl: string;        // e.g. https://localhost:8081
  macaroonHex: string;    // admin or invoice macaroon, hex
  tlsCert?: string | Buffer; // PEM; omit to use system CAs
}

export interface LndInvoice { paymentRequest: string; paymentHash: Uint8Array; addIndex: string }
export interface LndInvoiceStatus { settled: boolean; state: string; amtPaidSat: number; preimage?: Uint8Array }
export interface LndDecodedPayReq { paymentHash: Uint8Array; numSatoshis: number; expiry: number; description: string; destination: string }
export interface LndPaymentResult { preimage: Uint8Array; paymentHash: Uint8Array; feeSat: number }

const b64ToBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

export class LndRestClient {
  private readonly base: URL;
  private readonly macaroonHex: string;
  private readonly ca?: string | Buffer;

  constructor(opts: LndRestOptions) {
    this.base = new URL(opts.baseUrl);
    this.macaroonHex = opts.macaroonHex;
    this.ca = opts.tlsCert;
  }

  /** Convenience: build from a cert path + macaroon path (as exported by infra/setup-ln.sh). */
  static fromFiles(baseUrl: string, tlsCertPath: string, macaroonPath: string): LndRestClient {
    return new LndRestClient({ baseUrl, tlsCert: readFileSync(tlsCertPath), macaroonHex: toHex(new Uint8Array(readFileSync(macaroonPath))) });
  }

  private call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = httpsRequest(
        {
          host: this.base.hostname,
          port: this.base.port || 443,
          path,
          method,
          ca: this.ca,
          servername: this.base.hostname,
          headers: {
            'Grpc-Metadata-macaroon': this.macaroonHex,
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(text) as T); } catch (e) { reject(e); }
            } else {
              reject(new Error(`LND ${method} ${path} → ${res.statusCode}: ${text}`));
            }
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  async getInfo(): Promise<{ identity_pubkey: string; alias: string; synced_to_chain: boolean }> {
    return this.call('GET', '/v1/getinfo');
  }

  async addInvoice(params: { valueSat: number; memo?: string; expirySeconds?: number }): Promise<LndInvoice> {
    const r = await this.call<{ r_hash: string; payment_request: string; add_index: string }>('POST', '/v1/invoices', {
      value: String(params.valueSat),
      memo: params.memo ?? '',
      ...(params.expirySeconds ? { expiry: String(params.expirySeconds) } : {}),
    });
    return { paymentRequest: r.payment_request, paymentHash: b64ToBytes(r.r_hash), addIndex: r.add_index };
  }

  async lookupInvoice(paymentHash: Uint8Array): Promise<LndInvoiceStatus> {
    const r = await this.call<{ settled: boolean; state: string; amt_paid_sat: string; r_preimage?: string }>('GET', `/v1/invoice/${toHex(paymentHash)}`);
    const pre = r.r_preimage ? b64ToBytes(r.r_preimage) : undefined;
    return { settled: r.settled, state: r.state, amtPaidSat: Number(r.amt_paid_sat), preimage: pre && pre.some((b) => b !== 0) ? pre : undefined };
  }

  async decodePayReq(payReq: string): Promise<LndDecodedPayReq> {
    const r = await this.call<{ payment_hash: string; num_satoshis: string; expiry: string; description: string; destination: string }>('GET', `/v1/payreq/${encodeURIComponent(payReq)}`);
    return { paymentHash: fromHex(r.payment_hash), numSatoshis: Number(r.num_satoshis), expiry: Number(r.expiry), description: r.description, destination: r.destination };
  }

  /** Pays a BOLT11 invoice synchronously; resolves with the preimage on success. */
  async payInvoice(payReq: string, opts?: { feeLimitSat?: number }): Promise<LndPaymentResult> {
    const r = await this.call<{ payment_error: string; payment_preimage: string; payment_hash: string; payment_route?: { total_fees?: string } }>('POST', '/v1/channels/transactions', {
      payment_request: payReq,
      fee_limit: { fixed: String(opts?.feeLimitSat ?? 10) },
    });
    if (r.payment_error) throw new Error(`payment failed: ${r.payment_error}`);
    return { preimage: b64ToBytes(r.payment_preimage), paymentHash: b64ToBytes(r.payment_hash), feeSat: Number(r.payment_route?.total_fees ?? 0) };
  }
}

/** Adapts an LND node into the Mint's Challenger (invoice issuer). */
export class LndChallenger implements Challenger {
  constructor(private readonly lnd: LndRestClient, private readonly invoiceExpirySeconds = 3600) {}
  async newChallenge(amountSat: number, memo?: string) {
    const inv = await this.lnd.addInvoice({ valueSat: amountSat, memo, expirySeconds: this.invoiceExpirySeconds });
    return { invoice: inv.paymentRequest, paymentHash: inv.paymentHash };
  }
}
