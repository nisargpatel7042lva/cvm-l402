// Dumps recent events by the dev server pubkey from the local relay (Phase 0 sanity check).
import WebSocket from 'ws';
const pk = process.argv[2] ?? '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';
const ws = new WebSocket(process.env.RELAY_URL ?? 'ws://localhost:7777');
ws.on('open', () => ws.send(JSON.stringify(['REQ', 'x', { authors: [pk], limit: 50 }])));
ws.on('message', (m) => {
  const d = JSON.parse(m);
  if (d[0] === 'EVENT') { const e = d[2]; console.log('kind', e.kind, 'tags', JSON.stringify(e.tags.slice(0, 2)), '|', e.content.slice(0, 60)); }
  if (d[0] === 'EOSE') ws.close();
});
