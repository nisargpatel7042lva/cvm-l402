/**
 * Phase 0 hello-world: an unpriced MCP tool exposed over Nostr via the
 * ContextVM Gateway. The MCP server runs in-process and is bridged to the
 * gateway through an InMemoryTransport pair (same shape as a stdio bridge,
 * minus the child process).
 */
import { McpServer } from '@contextvm/mcp-sdk/server/mcp.js';
import { InMemoryTransport } from '@contextvm/mcp-sdk/inMemory.js';
import { NostrMCPGateway } from '@contextvm/sdk/gateway';
import { ApplesauceRelayPool } from '@contextvm/sdk/relay';
import { z } from 'zod';
import { RELAY_URLS, serverSigner } from './dev-config.js';

const mcp = new McpServer({ name: 'cvm-l402-hello', version: '0.0.1' });
mcp.registerTool(
  'hello',
  {
    description: 'Free greeting tool (Phase 0 smoke test)',
    inputSchema: { name: z.string().describe('Who to greet') },
  },
  async ({ name }) => ({
    content: [{ type: 'text', text: `hello, ${name}! (served over Nostr)` }],
  }),
);

const [mcpSide, gatewaySide] = InMemoryTransport.createLinkedPair();
await mcp.connect(mcpSide);

const gateway = new NostrMCPGateway({
  mcpClientTransport: gatewaySide,
  nostrTransportOptions: {
    signer: serverSigner,
    relayHandler: new ApplesauceRelayPool(RELAY_URLS),
    serverInfo: { name: 'cvm-l402-hello' },
    isPublicServer: true,
    isAnnouncedServer: true,
  },
});

await gateway.start();
console.log('gateway up');
console.log('  relay :', RELAY_URLS.join(', '));
console.log('  pubkey:', await serverSigner.getPublicKey());

const shutdown = async () => {
  await gateway.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
