/**
 * Fixed dev-only identities and endpoints for the local regtest stack.
 * These keys are throwaway: never use them outside the local relay.
 */
import { PrivateKeySigner } from '@contextvm/sdk/signer';

export const RELAY_URLS = [process.env.RELAY_URL ?? 'ws://localhost:7777'];

// 32-byte hex secrets; deterministic so the client can hardcode the server pubkey.
export const SERVER_SECRET =
  '1111111111111111111111111111111111111111111111111111111111111111';
export const CLIENT_SECRET =
  '2222222222222222222222222222222222222222222222222222222222222222';

export const serverSigner = new PrivateKeySigner(SERVER_SECRET);
export const clientSigner = new PrivateKeySigner(CLIENT_SECRET);
