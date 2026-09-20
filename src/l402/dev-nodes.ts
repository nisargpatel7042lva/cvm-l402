/** LND REST clients for the two regtest nodes from infra/docker-compose.yml + infra/setup-ln.sh. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LndRestClient } from './lnd-rest.js';

const CREDS = resolve(process.env.CVM_CREDS_DIR ?? resolve(import.meta.dirname, '../../infra/creds'));

export const devCredsAvailable = (): boolean =>
  ['server-tls.cert', 'server-admin.macaroon', 'agent-tls.cert', 'agent-admin.macaroon'].every((f) => existsSync(resolve(CREDS, f)));

/** The tool server's node: issues invoices. */
export const serverLnd = (): LndRestClient =>
  LndRestClient.fromFiles(process.env.LND_SERVER_REST ?? 'https://localhost:8081', resolve(CREDS, 'server-tls.cert'), resolve(CREDS, 'server-admin.macaroon'));

/** The agent's node: pays invoices. */
export const agentLnd = (): LndRestClient =>
  LndRestClient.fromFiles(process.env.LND_AGENT_REST ?? 'https://localhost:8082', resolve(CREDS, 'agent-tls.cert'), resolve(CREDS, 'agent-admin.macaroon'));
