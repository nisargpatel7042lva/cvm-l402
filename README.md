# cvm-l402 — L402 payment rail for ContextVM (CEP-8)

Adds L402 (Lightning HTTP 402 / macaroon + preimage) as a CEP-8 payment rail so an
autonomous agent can discover a priced MCP tool over Nostr, pay via Lightning, and
retry with proof of payment — no human wallet interaction.

Built for the Bitshala BOSS Battle hackathon (Machine Money track).

## Status

- **Phase 0 (env + gap validation): done.** See `docs/phase-0.md`.

## Local stack (regtest, headless "Polar")

```
docker compose (infra/docker-compose.yml)
  cvm-bitcoind    regtest bitcoind             rpc :18443
  cvm-lnd-server  tool server's LND node       rest :8081  grpc :10009
  cvm-lnd-agent   agent's LND node             rest :8082  grpc :10010
  cvm-relay       nostr-rs-relay               ws   :7777
```

Docker Desktop's credential helper isn't on the WSL PATH, so compose is run with an
isolated config: `export DOCKER_CONFIG=$PWD/infra/.docker`.

### Bring up

```bash
export DOCKER_CONFIG=$PWD/infra/.docker
docker compose -f infra/docker-compose.yml up -d
./infra/setup-ln.sh        # funds wallets, opens agent->server channel, exports creds to infra/creds/
```

### Hello-world over Nostr (Phase 0 gate)

```bash
npm run hello:server       # terminal 1
npm run hello:client       # terminal 2 -> prints tools: ['hello'] and the greeting
```

### Handy

```bash
node scripts/relay-dump.mjs               # events the server published to the relay
docker exec cvm-lnd-agent lncli --network=regtest --lnddir=/home/lnd/.lnd listchannels
```
