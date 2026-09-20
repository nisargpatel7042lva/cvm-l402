/**
 * A deterministic CEP-8 payment rail for exercising the SDK's payment
 * middleware without any real money. PMI: `stub-v1`.
 *
 * Both halves share an in-memory ledger (same process), which is exactly the
 * "does the CEP-8 flow work, independent of a rail" isolation we want:
 *
 *   processor.createPaymentRequired → pay_req `stub:<n>` + the proof the ledger expects
 *   handler.handle                  → writes a proof for that pay_req (correct, wrong, or nothing)
 *   processor.verifyPayment         → waits for the proof; resolves if correct, throws if wrong
 */
import type {
  PaymentHandler,
  PaymentHandlerRequest,
  PaymentProcessor,
  PaymentProcessorCreateParams,
  PaymentProcessorVerifyParams,
} from '@contextvm/sdk/payments';

export const PMI_STUB = 'stub-v1';

export class StubLedger {
  private n = 0;
  readonly expected = new Map<string, { amount: number; proof: string }>();
  readonly submitted = new Map<string, string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  issue(amount: number): { payReq: string; proof: string } {
    const payReq = `stub:${++this.n}`;
    const proof = `proof-${payReq}-${amount}`;
    this.expected.set(payReq, { amount, proof });
    return { payReq, proof };
  }

  submit(payReq: string, proof: string): void {
    this.submitted.set(payReq, proof);
    for (const w of this.waiters.get(payReq) ?? []) w();
    this.waiters.delete(payReq);
  }

  /** Resolves once a proof for `payReq` has been submitted (or rejects on abort). */
  waitForSubmission(payReq: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const p = this.submitted.get(payReq);
        if (p !== undefined) resolve(p);
      };
      if (this.submitted.has(payReq)) return check();
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
      (this.waiters.get(payReq) ?? this.waiters.set(payReq, []).get(payReq)!).push(check);
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('verifyPayment aborted')), { once: true });
    });
  }
}

export class StubPaymentProcessor implements PaymentProcessor {
  readonly pmi = PMI_STUB;
  readonly created: PaymentProcessorCreateParams[] = [];
  readonly verified: Array<{ payReq: string; ok: boolean }> = [];

  constructor(private readonly ledger: StubLedger, private readonly opts: { ttlSeconds?: number } = {}) {}

  async createPaymentRequired(params: PaymentProcessorCreateParams) {
    this.created.push(params);
    const { payReq } = this.ledger.issue(params.amount);
    return {
      amount: params.amount,
      pay_req: payReq,
      description: params.description,
      pmi: this.pmi,
      ...(this.opts.ttlSeconds !== undefined && { ttl: this.opts.ttlSeconds }),
      _meta: { stub: true },
    };
  }

  async verifyPayment(params: PaymentProcessorVerifyParams) {
    const proof = await this.ledger.waitForSubmission(params.pay_req, params.abortSignal);
    const ok = this.ledger.expected.get(params.pay_req)?.proof === proof;
    this.verified.push({ payReq: params.pay_req, ok });
    if (!ok) throw new Error(`stub rail: invalid proof for ${params.pay_req}`);
    return { _meta: { stub_proof: proof } };
  }
}

export type StubHandlerMode = 'pay' | 'pay-wrong-proof' | 'decline';

export class StubPaymentHandler implements PaymentHandler {
  readonly pmi = PMI_STUB;
  readonly requests: PaymentHandlerRequest[] = [];
  mode: StubHandlerMode;

  constructor(private readonly ledger: StubLedger, mode: StubHandlerMode = 'pay') { this.mode = mode; }

  async canHandle(_req: PaymentHandlerRequest): Promise<boolean> {
    return this.mode !== 'decline';
  }

  /** "Pays": submits a proof for the pay_req to the shared ledger. */
  async handle(req: PaymentHandlerRequest): Promise<void> {
    this.requests.push(req);
    const proof = this.mode === 'pay' ? this.ledger.expected.get(req.pay_req)?.proof ?? 'unknown' : 'WRONG';
    this.ledger.submit(req.pay_req, proof);
  }
}
