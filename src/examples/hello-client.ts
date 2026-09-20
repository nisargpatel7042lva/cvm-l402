/**
 * Phase 0 hello-world client: connects to the gateway over Nostr, lists
 * tools, and calls the free `hello` tool.
 */
import { Client } from '@contextvm/mcp-sdk/client/index.js';
import { NostrClientTransport } from '@contextvm/sdk/transport';
import { ApplesauceRelayPool } from '@contextvm/sdk/relay';
import { RELAY_URLS, clientSigner, serverSigner } from './dev-config.js';

const serverPubkey = await serverSigner.getPublicKey();

const transport = new NostrClientTransport({
  signer: clientSigner,
  relayHandler: new ApplesauceRelayPool(RELAY_URLS),
  serverPubkey,
});

const client = new Client({ name: 'cvm-l402-hello-client', version: '0.0.1' });
await client.connect(transport);
console.log('connected to', serverPubkey);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name));

const result = await client.callTool({ name: 'hello', arguments: { name: 'agent' } });
console.log('hello ->', JSON.stringify(result.content));

await client.close();
process.exit(0);
