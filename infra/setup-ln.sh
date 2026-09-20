#!/usr/bin/env bash
# Bootstraps the regtest Lightning network: funds both LND wallets, opens an
# agent -> server channel, and confirms it. Idempotent: safe to re-run.
set -euo pipefail

BTC="docker exec cvm-bitcoind bitcoin-cli -regtest -rpcuser=polaruser -rpcpassword=polarpass"
SRV="docker exec cvm-lnd-server lncli --network=regtest --lnddir=/home/lnd/.lnd"
AGT="docker exec cvm-lnd-agent lncli --network=regtest --lnddir=/home/lnd/.lnd"

wait_synced() {
  local cli="$1" name="$2"
  for _ in $(seq 1 60); do
    if $cli getinfo 2>/dev/null | grep -q '"synced_to_chain": true'; then
      echo "  $name synced"; return 0
    fi
    sleep 2
  done
  echo "timeout waiting for $name to sync" >&2; exit 1
}

mine() { $BTC generatetoaddress "$1" "$MINER_ADDR" >/dev/null; }

echo "==> bitcoind: ensure miner wallet + spendable coins"
$BTC -named createwallet wallet_name=miner load_on_startup=true >/dev/null 2>&1 || $BTC loadwallet miner >/dev/null 2>&1 || true
MINER_ADDR=$($BTC -rpcwallet=miner getnewaddress)
HEIGHT=$($BTC getblockcount)
if [ "$HEIGHT" -lt 101 ]; then mine $((101 - HEIGHT + 5)); fi

echo "==> waiting for LND nodes"
wait_synced "$SRV" lnd-server
wait_synced "$AGT" lnd-agent

fund_if_needed() {
  local cli="$1" name="$2"
  local bal
  bal=$($cli walletbalance | python3 -c 'import sys,json; print(int(json.load(sys.stdin)["confirmed_balance"]))')
  if [ "$bal" -lt 50000000 ]; then
    local addr
    addr=$($cli newaddress p2wkh | python3 -c 'import sys,json; print(json.load(sys.stdin)["address"])')
    $BTC -rpcwallet=miner sendtoaddress "$addr" 1 >/dev/null
    echo "  funded $name with 1 BTC"
  else
    echo "  $name already funded ($bal sat)"
  fi
}
echo "==> funding wallets"
fund_if_needed "$AGT" lnd-agent
fund_if_needed "$SRV" lnd-server
mine 6
wait_synced "$SRV" lnd-server
wait_synced "$AGT" lnd-agent

SRV_PUB=$($SRV getinfo | python3 -c 'import sys,json; print(json.load(sys.stdin)["identity_pubkey"])')
AGT_PUB=$($AGT getinfo | python3 -c 'import sys,json; print(json.load(sys.stdin)["identity_pubkey"])')
echo "  server node: $SRV_PUB"
echo "  agent  node: $AGT_PUB"

echo "==> peering + channel (agent -> server)"
$AGT connect "$SRV_PUB@lnd-server:9735" >/dev/null 2>&1 || true
if ! $AGT listchannels | grep -q "$SRV_PUB"; then
  $AGT openchannel --node_key="$SRV_PUB" --local_amt=10000000 --push_amt=2000000 >/dev/null
  mine 6
  for _ in $(seq 1 30); do
    if $AGT listchannels | grep -q '"active": true'; then break; fi
    sleep 2
  done
  echo "  channel opened"
else
  echo "  channel already exists"
fi
$AGT listchannels | python3 -c 'import sys,json
for c in json.load(sys.stdin)["channels"]:
    print("  chan", c["chan_id"], "active=" + str(c["active"]), "local=" + c["local_balance"], "remote=" + c["remote_balance"])' 

echo "==> exporting credentials to infra/creds/"
mkdir -p infra/creds
docker cp cvm-lnd-server:/home/lnd/.lnd/tls.cert infra/creds/server-tls.cert
docker cp cvm-lnd-server:/home/lnd/.lnd/data/chain/bitcoin/regtest/admin.macaroon infra/creds/server-admin.macaroon
docker cp cvm-lnd-server:/home/lnd/.lnd/data/chain/bitcoin/regtest/invoice.macaroon infra/creds/server-invoice.macaroon
docker cp cvm-lnd-agent:/home/lnd/.lnd/tls.cert infra/creds/agent-tls.cert
docker cp cvm-lnd-agent:/home/lnd/.lnd/data/chain/bitcoin/regtest/admin.macaroon infra/creds/agent-admin.macaroon
echo "done."
