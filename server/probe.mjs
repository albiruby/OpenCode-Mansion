import WebSocket from 'ws';

const url = process.argv[2] ?? 'ws://127.0.0.1:4040';
const duration = Number(process.argv[3] ?? 15000);
const ws = new WebSocket(url);

ws.on('open', () => console.log('PROBE_OPEN'));
ws.on('message', (d) => console.log('PROBE_MSG', d.toString()));
ws.on('error', (e) => {
  console.log('PROBE_ERR', e.message);
  process.exit(1);
});
ws.on('close', () => console.log('PROBE_CLOSE'));

setTimeout(() => {
  ws.close();
  setTimeout(() => process.exit(0), 300);
}, duration);
