// Ask the running pet to apply a given appearance (used to verify that the
// character still fits the window at every size). Talks to the pet's WebView2
// over CDP, so the pet must be running with --remote-debugging-port.
//   node tools/set_size.mjs 480
const PORT = Number(process.env.PET_CDP_PORT || 9333);
const size = Number(process.argv[2] || 200);

import http from 'node:http';

function get(path) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(d));
    });
    req.on('error', rej);
    req.setTimeout(1500, () => req.destroy(new Error('timeout')));
  });
}

const list = JSON.parse(await get('/json/list'));
// Tauri 的页面 URL 是 "http://tauri.localhost/"（不带 index.html），
// 所以只按主机名/协议筛；about:blank 那种早期 target 要排掉。
const page = list.find((t) => t.type === 'page' && t.url && !t.url.startsWith('about:'));
if (!page) { console.error('pet page not found in CDP targets:', list.map((t) => t.url)); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});

const expr = `(async () => {
  const P = window.PresagePet;
  if (!P) return 'no PresagePet';
  await P.applyAppearanceFromSettings(JSON.stringify({ size: ${size} }));
  await new Promise((r) => setTimeout(r, 800));
  const hit = document.getElementById('pet-hit').getBoundingClientRect();
  const list = document.getElementById('bubble-list').getBoundingClientRect();
  return JSON.stringify({
    size: ${size},
    win: [innerWidth, innerHeight],
    petTop: Math.round(hit.top), petBottomFromWinBottom: Math.round(innerHeight - hit.bottom),
    clipped: Math.max(0, Math.round(-hit.top)) + Math.max(0, Math.round(hit.bottom - innerHeight)),
    bubbleTop: Math.round(list.top),
  });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log(res.result?.result?.value ?? JSON.stringify(res));
ws.close();
