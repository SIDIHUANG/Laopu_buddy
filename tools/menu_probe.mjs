// 在真实浏览器里量右键菜单尺寸，并按桌宠窗口的各国尺寸检查摆位是否会被裁。
// 用法：先 `python -m http.server 8795 --directory app/dist`，再 `node tools/menu_probe.mjs`
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const URL_ = process.env.PAGE_URL || 'http://127.0.0.1:8795/?debug=1';

const profile = mkdtempSync(join(tmpdir(), 'menu-probe-'));

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

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=400,400',
  'about:blank',
], { stdio: 'ignore', detached: false });

const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

async function waitTargets(ms = 20000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const j = JSON.parse(await get('/json/list'));
      const page = j.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('CDP target not found');
}

const page = await waitTargets();
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

// 一个能算出"窗口各国尺寸"的最小复刻，避免为了这个去加载整个应用
const SIZES = [200, 240, 320, 400, 480];
const CONTENT_SCALE = 0.98, MARGIN = 0.04, BUBBLE_SPACE = 116;

const measure = `(() => {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-9999px;top:0;';
  host.innerHTML = \`<div id="ctx-menu" style="position:fixed;z-index:200;min-width:118px;padding:4px;
    background:rgba(28,30,38,.96);border-radius:8px;color:#eef0f4;
    box-shadow:0 4px 14px rgba(0,0,0,.35);font-size:12px;
    border:1px solid rgba(255,255,255,.1)">
    <button style="display:block;width:100%;text-align:left;border:0;cursor:pointer;
      background:transparent;color:inherit;font:inherit;padding:5px 8px;border-radius:5px">设置…</button>
    <button style="display:block;width:100%;text-align:left;border:0;cursor:pointer;
      background:transparent;color:inherit;font:inherit;padding:5px 8px;border-radius:5px">强制可交互 60 秒</button>
    <button style="display:block;width:100%;text-align:left;border:0;cursor:pointer;
      background:transparent;color:inherit;font:inherit;padding:5px 8px;border-radius:5px">强制穿透 5 秒</button>
    <button style="display:block;width:100%;text-align:left;border:0;cursor:pointer;
      background:transparent;color:inherit;font:inherit;padding:5px 8px;border-radius:5px">清除全部气泡</button>
    <button style="display:block;width:100%;text-align:left;border:0;cursor:pointer;
      background:transparent;color:inherit;font:inherit;padding:5px 8px;border-radius:5px">退出</button>
  </div>\`;
  document.body.appendChild(host);
  const m = host.querySelector('#ctx-menu');
  m.style.font = getComputedStyle(document.body).font;
  const r = m.getBoundingClientRect();
  return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) });
})()`;

await send('Page.navigate', { url: URL_ });
await new Promise((r) => setTimeout(r, 2500));
const res = await send('Runtime.evaluate', { expression: measure, returnByValue: true });
const menu = JSON.parse(res.result?.result?.value || '{}');
console.log('=== 右键菜单真实尺寸 ===');
console.log(`  宽 ${menu.w}px  高 ${menu.h}px`);

console.log('\n=== 各尺寸下：窗口还能给菜单腾出多少空间 ===');
console.log('  size   窗口       角色高   头顶以上  菜单高   结论');
for (const size of SIZES) {
  const winW = size + 140;
  const winH = Math.round(size * CONTENT_SCALE + BUBBLE_SPACE);
  const charH = size * CONTENT_SCALE;
  const feet = size * MARGIN;
  const above = winH - charH - feet;
  const fits = above >= menu.h;
  console.log(`  ${String(size).padStart(4)}  ${String(winW) + 'x' + winH}`.padEnd(18)
    + `  ${String(Math.round(charH)).padStart(6)}  ${String(Math.round(above)).padStart(8)}`
    + `  ${String(menu.h).padStart(6)}   ${fits ? '够' : `不够（差 ${Math.round(menu.h - above)}px）`}`);
}

ws.close();
cleanup();
console.log('\ndone');
