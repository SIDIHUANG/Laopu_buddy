// Measure the real geometry of the pet window's visible layers.
// Run:  node tools/geom_probe.mjs
// Uses CDP against the running WebView2 instance. It temporarily enables
// remote debugging through the WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var,
// so it must launch the pet itself.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const exe = join(root, 'v1', 'presage-pet.exe');
// 注意：profile 必须放在工作区内。DSH 的沙箱不允许 msedgewebview2 子进程在
// 工作区外创建 profile 目录，那里的失败形态是 HRESULT 0x8000FFFF，
// 和"profile 损坏"长得一模一样，很容易误判（实测踩过）。
const profile = join(root, 'runtime', 'wv2-geom');
const logDir = join(root, 'v1', 'runtime');

const PORT = 9333;

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

async function waitTargets(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const j = JSON.parse(await get('/json/list'));
      const page = j.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('CDP target not found');
}

async function main() {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
  process.env.WEBVIEW2_USER_DATA_FOLDER = profile;
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
    `--remote-debugging-port=${PORT} --remote-allow-origins=* --disable-gpu`;
  process.env.PRESAGE_SOURCE = process.env.PRESAGE_SOURCE || 'live';

  const child = spawn(exe, [], { cwd: join(root, 'v1'), detached: true, stdio: 'ignore' });
  child.unref();
  console.log('[geom] pet pid =', child.pid);

  const page = await waitTargets();
  console.log('[geom] CDP target:', page.title, page.url);

  const WebSocket = (await import('node:worker_threads')) && globalThis.WebSocket;
  if (!WebSocket) throw new Error('no WebSocket global');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  const expr = `(() => {
    const q = (s) => document.querySelector(s);
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
    const P = window.PresagePet || {};
    const R = P.renderer || null;
    return {
      innerW: innerWidth, innerH: innerHeight,
      dpr: devicePixelRatio,
      screen: { w: screen.width, h: screen.height, availH: screen.availHeight },
      stage: box(q('#stage')),
      bubbles: box(q('#bubble-list')),
      hit: box(q('#pet-hit')),
      cur: box(q('#pet-cur')),
      count: box(q('#collapsed-count')),
      curStyle: (() => { const c = q('#pet-cur'); return c ? {
        bg: c.style.backgroundImage && c.style.backgroundImage.slice(0, 60),
        size: c.style.backgroundSize, pos: c.style.backgroundPosition,
        op: c.style.opacity, tf: c.style.transform } : null; })(),
      prevStyle: (() => { const c = q('#pet-prev'); return c ? {
        bg: c.style.backgroundImage && c.style.backgroundImage.slice(0, 60),
        op: c.style.opacity } : null; })(),
      renderer: R ? { size: R.size, height: R.height, dpr: R.dpr, state: R.state, fade: R.fade } : null,
      scrollH: document.scrollingElement.scrollHeight,
      clientH: document.scrollingElement.clientHeight,
    };
  })()`;

  for (const wait of [2500, 3000, 3000]) {
    await new Promise((r) => setTimeout(r, wait));
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const v = res.result?.result?.value;
    console.log('\n===== geometry @ ' + new Date().toLocaleTimeString() + ' =====');
    console.log(JSON.stringify(v, null, 2));
    // also ask the page to log the same, so it lands in pet.out.log
    await send('Runtime.evaluate', {
      expression: `window.__TAURI__ && window.__TAURI__.core.invoke('front_log',{msg:'[geom] ' + ${JSON.stringify('JSON')} + '=' + JSON.stringify(${expr.replace(/\n/g, ' ')})})`,
      returnByValue: true,
    }).catch(() => {});
  }

  // keep one dump on disk
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  writeFileSync(join(root, 'runtime', 'geom.json'), JSON.stringify(res.result?.result?.value, null, 2), 'utf8');
  ws.close();
  console.log('\n[geom] left the pet running (pid ' + child.pid + '); kill it when done');
}

main().catch((e) => { console.error('[geom] FAILED:', e.message); process.exit(1); });
