/**
 * Spins up a paid MCP server (via NostrMCPGateway + CEP-8 payments) and a
 * paying client on the local relay, with a tap that records every JSON-RPC
 * message the client transport receives. Used by tests and the demo.
 */
import { McpServer } from '@contextvm/mcp-sdk/server/mcp.js';
import { Client } from '@contextvm/mcp-sdk/client/index.js';
import { InMemoryTransport } from '@contextvm/mcp-sdk/inMemory.js';
import type { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';
import { NostrMCPGateway } from '@contextvm/sdk/gateway';
import { NostrClientTransport } from '@contextvm/sdk/transport';
import { ApplesauceRelayPool } from '@contextvm/sdk/relay';
import { PrivateKeySigner } from '@contextvm/sdk/signer';
import { withClientPayments, type ClientPaymentsOptions, type PaymentProcessor, type PricedCapability, type ResolvePriceFn } from '@contextvm/sdk/payments';
import { z } from 'zod';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';

export const RELAY_URL = process.env.RELAY_URL ?? 'ws://localhost:7777';
export const PREMIUM_PRICE_SAT = 21;

export interface PaidServerOptions {
  processors: PaymentProcessor[];
  resolvePrice?: ResolvePriceFn;
  paymentTtlMs?: number;
  relayUrl?: string;
}

export async function startPaidServer(opts: PaidServerOptions) {
  const sk = generateSecretKey();
  const signer = new PrivateKeySigner(bytesToHex(sk));
  const pubkey = getPublicKey(sk);

  const mcp = new McpServer({ name: 'cvm-l402-paid', version: '0.0.1' });
  mcp.registerTool('hello', { description: 'free', inputSchema: { name: z.string() } }, async ({ name }) => ({
    content: [{ type: 'text', text: `hello, ${name}` }],
  }));
  mcp.registerTool('premium_echo', { description: `paid: ${PREMIUM_PRICE_SAT} sats`, inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text: `PREMIUM: ${text}` }],
  }));
  const [mcpSide, gwSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(mcpSide);

  const pricedCapabilities: PricedCapability[] = [
    { method: 'tools/call', name: 'premium_echo', amount: PREMIUM_PRICE_SAT, currencyUnit: 'sats', description: 'premium_echo invocation' },
  ];

  const gateway = new NostrMCPGateway({
    mcpClientTransport: gwSide,
    nostrTransportOptions: {
      signer,
      relayHandler: new ApplesauceRelayPool([opts.relayUrl ?? RELAY_URL]),
      serverInfo: { name: 'cvm-l402-paid' },
      isPublicServer: true,
      isAnnouncedServer: true,
    },
    paymentOptions: {
      processors: opts.processors,
      pricedCapabilities,
      resolvePrice: opts.resolvePrice,
      paymentTtlMs: opts.paymentTtlMs,
    },
  });
  await gateway.start();

  return {
    pubkey,
    pricedCapabilities,
    stop: async () => { await gateway.stop(); await mcp.close(); },
  };
}

export interface TappedMessage { message: JSONRPCMessage; at: number }

export async function startPayingClient(serverPubkey: string, payments: ClientPaymentsOptions, relayUrl = RELAY_URL) {
  const sk = generateSecretKey();
  const base = new NostrClientTransport({
    signer: new PrivateKeySigner(bytesToHex(sk)),
    relayHandler: new ApplesauceRelayPool([relayUrl]),
    serverPubkey,
  });

  // Tap: intercept whatever withClientPayments installs as onmessageWithContext
  // so tests can see the raw CEP-8 notifications *before* the middleware acts.
  const tapped: TappedMessage[] = [];
  let inner: NostrClientTransport['onmessageWithContext'];
  Object.defineProperty(base, 'onmessageWithContext', {
    configurable: true,
    get: () => inner,
    set: (fn: NostrClientTransport['onmessageWithContext']) => {
      inner = fn ? (m, ctx) => { tapped.push({ message: m, at: Date.now() }); fn(m, ctx); } : fn;
    },
  });

  const transport = withClientPayments(base, payments);
  const client = new Client({ name: 'cvm-l402-agent', version: '0.0.1' });
  await client.connect(transport);

  return {
    client,
    base,
    tapped,
    notifications: (method: string) => tapped.filter((t) => 'method' in t.message && t.message.method === method).map((t) => t.message as { method: string; params?: Record<string, unknown> }),
    stop: async () => { await client.close(); },
  };
}
